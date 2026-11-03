/**
 * Owns the native effects overlay: compiles the C# WPF source with the .NET
 * Framework compiler (csc.exe) when needed, then runs it as a child of the host.
 *
 * Why C# instead of PowerShell/WPF: some managed Windows machines enforce
 * `__PSLockdownPolicy=4` in the machine environment, so every PowerShell
 * process starts in ConstrainedLanguage and cannot load WPF. csc.exe is an
 * ordinary compiler executable and the produced overlay runs as a plain .NET
 * Framework app, so the overlay keeps working under that policy.
 *
 * The overlay is what makes effects visible while the user is in another
 * window: the web page can only paint inside its own window.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function localAppDataDir() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'dsh-desktop-alerts')
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

const CSC_CANDIDATES = [
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]

const WPF_DIR = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF')
const MSIL_GAC = join(
  process.env.WINDIR || 'C:\\Windows',
  'Microsoft.NET',
  'assembly',
  'GAC_MSIL',
  'System.Xaml',
  'v4.0_4.0.0.0__b77a5c561934e089',
  'System.Xaml.dll',
)

/** WPF assemblies are not resolvable by simple name from csc, so pass real paths. */
const CSC_REFERENCES = [
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  '/r:System.Web.Extensions.dll',
  `/r:${join(WPF_DIR, 'PresentationFramework.dll')}`,
  `/r:${join(WPF_DIR, 'PresentationCore.dll')}`,
  `/r:${join(WPF_DIR, 'WindowsBase.dll')}`,
  `/r:${MSIL_GAC}`,
]

export class WidgetLauncher {
  constructor(options = {}) {
    this.pkgRoot = options.pkgRoot
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.dir = localAppDataDir()
    this.configPath = join(this.dir, 'widget.json')
    this.pidPath = join(this.dir, 'widget.pid')
    this.sourcePath = join(this.pkgRoot, 'widget', 'DshDesktopAlertsFx.cs')
    this.exePath = join(this.dir, 'DshDesktopAlertsFx.exe')
    this.child = undefined
    this.pid = undefined
    this.compiling = false
    this.compileFailed = false
    this.csc = CSC_CANDIDATES.find((path) => existsSync(path))
  }

  available() {
    return existsSync(this.sourcePath) && Boolean(this.csc) && !this.compileFailed
  }

  running() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return true
    return isAlive(this.readPid())
  }

  readPid() {
    if (this.pid) return this.pid
    try {
      const pid = Number.parseInt(readFileSync(this.pidPath, 'utf8').trim(), 10)
      if (Number.isInteger(pid) && pid > 0) {
        this.pid = pid
        return pid
      }
    } catch {}
    return undefined
  }

  writeConfig(config) {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8')
  }

  /** Compile only when the source is newer than the binary (or the binary is missing). */
  compiled() {
    if (!existsSync(this.exePath)) return false
    return mtime(this.exePath) >= mtime(this.sourcePath)
  }

  compile(done) {
    if (this.compiling) return
    this.compiling = true
    const target = `${this.exePath}.new`
    try {
      rmSync(target, { force: true })
    } catch {}
    const args = ['/nologo', '/target:winexe', '/optimize+', `/out:${target}`, ...CSC_REFERENCES, this.sourcePath]
    let settled = false
    const finish = (ok, detail) => {
      if (settled) return
      settled = true
      this.compiling = false
      if (ok) {
        try {
          rmSync(this.exePath, { force: true })
          const source = readFileSync(target)
          writeFileSync(this.exePath, source)
          rmSync(target, { force: true })
          this.log('widget compiled')
          done?.(true)
          return
        } catch (error) {
          this.log(`widget install failed: ${error?.message ?? error}`)
        }
      }
      this.compileFailed = true
      this.log(`widget compile failed${detail ? `: ${detail}` : ''}`)
      done?.(false)
    }
    try {
      const child = spawn(this.csc, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.stderr?.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.on('error', (error) => finish(false, String(error?.message ?? error)))
      child.on('exit', (code) => finish(code === 0, code === 0 ? '' : output.trim().slice(0, 800)))
    } catch (error) {
      finish(false, String(error?.message ?? error))
    }
  }

  spawnWidget() {
    try {
      const child = spawn(this.exePath, ['-ConfigPath', this.configPath], {
        windowsHide: false,
        stdio: 'ignore',
        detached: false,
        cwd: this.dir,
      })
      child.on('error', (error) => this.log(`widget spawn error: ${error?.message ?? error}`))
      child.on('exit', (code) => {
        this.log(`widget exited with ${code}`)
        if (this.child === child) {
          this.child = undefined
          this.pid = undefined
          try {
            rmSync(this.pidPath, { force: true })
          } catch {}
        }
      })
      this.child = child
      this.pid = child.pid
      if (child.pid) {
        try {
          writeFileSync(this.pidPath, String(child.pid), 'utf8')
        } catch {}
      }
      return true
    } catch (error) {
      this.log(`widget spawn failed: ${error?.message ?? error}`)
      return false
    }
  }

  /** Write the token file and make sure one widget process is running. Never throws. */
  ensure(config) {
    try {
      // The token handshake file is written first: the widget, the fallback
      // overlay and the diagnostics log all read the same file.
      this.writeConfig(config)
      if (!existsSync(this.sourcePath)) {
        this.log('widget source missing; widget disabled')
        return false
      }
      if (!this.csc) {
        this.log('csc.exe not found; widget disabled')
        return false
      }
      if (this.compiling) return true
      const stale = !this.compiled()
      if (this.running()) {
        // 源码比 exe 新：换掉旧进程，重编译后再拉起来
        if (!stale) return true
        this.stop()
      }
      if (!stale) {
        this.spawnWidget()
        return true
      }
      this.compile((ok) => {
        if (ok) this.spawnWidget()
      })
      return true
    } catch (error) {
      this.log(`widget ensure failed: ${error?.message ?? error}`)
      return false
    }
  }

  stop() {
    const child = this.child
    const pid = this.readPid()
    this.child = undefined
    this.pid = undefined
    try {
      rmSync(this.pidPath, { force: true })
    } catch {}
    if (child && child.exitCode === null) {
      try {
        child.kill()
      } catch {}
    }
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid)
      } catch {}
    }
  }
}