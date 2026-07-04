const PREFIX = '[toolchain]'

export function info(msg: string): void {
  process.stderr.write(`${PREFIX} ${msg}\n`)
}

export function warn(msg: string): void {
  process.stderr.write(`${PREFIX} WARN ${msg}\n`)
}

export function error(msg: string): void {
  process.stderr.write(`${PREFIX} ERROR ${msg}\n`)
}

export function debug(msg: string): void {
  if (process.env.DEBUG) {
    process.stderr.write(`${PREFIX} DEBUG ${msg}\n`)
  }
}
