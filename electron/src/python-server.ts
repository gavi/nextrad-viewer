/**
 * Python Server Manager
 *
 * Manages the lifecycle of the Python FastAPI server subprocess.
 * This follows the ComfyUI architecture where the Electron app:
 * 1. Uses `uv` to install Python dependencies
 * 2. Spawns the Python server as a subprocess
 * 3. Monitors the server health via HTTP polling
 */

import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";
import * as http from "http";
import * as fs from "fs";
import { app } from "electron";
import * as os from "os";

export class PythonServer {
  private process: ChildProcess | null = null;
  private port: number;
  private isDev: boolean;
  private uvPath: string | null = null;

  constructor(port: number = 8188) {
    this.port = port;
    // Check if we're running in development or production
    this.isDev = !app.isPackaged;
  }

  private findUv(): string {
    // If already found, return cached path
    if (this.uvPath) return this.uvPath;

    const homeDir = os.homedir();

    // Common uv installation locations
    const uvLocations = [
      // User's local bin (most common for uv)
      path.join(homeDir, ".local", "bin", "uv"),
      // Homebrew on Apple Silicon
      "/opt/homebrew/bin/uv",
      // Homebrew on Intel Mac
      "/usr/local/bin/uv",
      // Cargo install location
      path.join(homeDir, ".cargo", "bin", "uv"),
      // System-wide
      "/usr/bin/uv",
    ];

    for (const uvPath of uvLocations) {
      if (fs.existsSync(uvPath)) {
        console.log(`Found uv at: ${uvPath}`);
        this.uvPath = uvPath;
        return uvPath;
      }
    }

    // Try to find uv using 'which' command as fallback
    try {
      const result = execSync("which uv", { encoding: "utf-8" }).trim();
      if (result && fs.existsSync(result)) {
        console.log(`Found uv via which: ${result}`);
        this.uvPath = result;
        return result;
      }
    } catch (e) {
      // which failed, continue
    }

    // uv not found anywhere
    throw new Error("UV_NOT_FOUND");
  }

  private getPythonPath(): string {
    if (this.isDev) {
      // Development: project root is two levels up from dist/
      return path.resolve(__dirname, "..", "..");
    } else {
      // Production: Python files are in resources/python/
      return path.join(process.resourcesPath, "python");
    }
  }

  private getEnhancedEnv(): NodeJS.ProcessEnv {
    const homeDir = os.homedir();

    // Build enhanced PATH that includes common binary locations
    const additionalPaths = [
      path.join(homeDir, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(homeDir, ".cargo", "bin"),
    ];

    const existingPath = process.env.PATH || "";
    const enhancedPath = [...additionalPaths, existingPath].join(":");

    return {
      ...process.env,
      PATH: enhancedPath,
      HOME: homeDir,
      PORT: String(this.port),
    };
  }

  async start(): Promise<void> {
    if (this.process) {
      console.log("Server is already running");
      return;
    }

    const pythonPath = this.getPythonPath();
    const uvPath = this.findUv();

    console.log(`Python path: ${pythonPath}`);
    console.log(`UV path: ${uvPath}`);
    console.log(`Running in ${this.isDev ? "development" : "production"} mode`);

    // Check if pyproject.toml exists
    const pyprojectPath = path.join(pythonPath, "pyproject.toml");
    if (!fs.existsSync(pyprojectPath)) {
      throw new Error(`pyproject.toml not found at ${pyprojectPath}`);
    }

    const env = this.getEnhancedEnv();

    return new Promise((resolve, reject) => {
      // First, ensure dependencies are installed with uv
      console.log("Installing dependencies with uv...");

      const uvInstall = spawn(uvPath, ["sync"], {
        cwd: pythonPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      uvInstall.stdout?.on("data", (data: Buffer) => {
        console.log(`[uv sync] ${data.toString().trim()}`);
      });

      uvInstall.stderr?.on("data", (data: Buffer) => {
        console.log(`[uv sync] ${data.toString().trim()}`);
      });

      uvInstall.on("close", (code) => {
        if (code !== 0) {
          console.warn(
            `uv sync exited with code ${code}, trying to start server anyway`
          );
        }

        this.startPythonServer(pythonPath, uvPath, env)
          .then(resolve)
          .catch(reject);
      });

      uvInstall.on("error", (err) => {
        console.error("Failed to run uv sync:", err);
        // Try to start the server anyway (deps might already be installed)
        this.startPythonServer(pythonPath, uvPath, env)
          .then(resolve)
          .catch(reject);
      });
    });
  }

  private async startPythonServer(
    pythonPath: string,
    uvPath: string,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`Starting Python server on port ${this.port}...`);

      // Use uv run to execute within the virtual environment
      this.process = spawn(
        uvPath,
        ["run", "python", "-m", "nexrad_viewer.server"],
        {
          cwd: pythonPath,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        }
      );

      // Capture stdout
      this.process.stdout?.on("data", (data: Buffer) => {
        console.log(`[Python] ${data.toString().trim()}`);
      });

      // Capture stderr
      this.process.stderr?.on("data", (data: Buffer) => {
        console.error(`[Python] ${data.toString().trim()}`);
      });

      this.process.on("error", (err) => {
        console.error("Failed to start Python process:", err);
        reject(err);
      });

      this.process.on("close", (code) => {
        console.log(`Python process exited with code ${code}`);
        this.process = null;
      });

      // Wait for the server to be ready
      this.waitForServer()
        .then(resolve)
        .catch((err) => {
          this.stop();
          reject(err);
        });
    });
  }

  private async waitForServer(
    timeout: number = 60000,
    interval: number = 500
  ): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error("Server startup timeout"));
          return;
        }

        const req = http.get(
          `http://localhost:${this.port}/api/health`,
          (res) => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              setTimeout(check, interval);
            }
          }
        );

        req.on("error", () => {
          setTimeout(check, interval);
        });

        req.end();
      };

      check();
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown takes too long
        if (this.process) {
          this.process.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      this.process!.on("close", () => {
        clearTimeout(timeout);
        this.process = null;
        resolve();
      });

      // Try graceful shutdown first
      this.process!.kill("SIGTERM");
    });
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getPort(): number {
    return this.port;
  }
}
