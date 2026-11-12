import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [profile, appOrigin, providerOrigin, executablePath] = process.argv.slice(2)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const browserProcess = spawn(executablePath, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  '--headless=new',
  '--ignore-certificate-errors',
  '--disable-background-networking',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })
process.once('disconnect', () => browserProcess.kill('SIGKILL'))

try {
  let launchError
  browserProcess.once('error', (error) => { launchError = error })
  browserProcess.once('exit', () => process.send?.({ type: 'browser-exit' }))
  let debuggingPort
  const startupDeadline = Date.now() + 20_000
  while (!debuggingPort && Date.now() < startupDeadline) {
    if (launchError) throw launchError
    if (browserProcess.exitCode !== null) throw new Error('Fixture browser exited during startup')
    const address = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
    if (/^[0-9]+\r?\n/.test(address)) debuggingPort = Number(address.split('\n')[0])
    else await delay(100)
  }
  if (!debuggingPort) throw new Error('Fixture browser DevTools endpoint was unavailable')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`)
  const [context] = browser.contexts()
  process.on('message', (message) => {
    if (message === 'crash') browserProcess.kill('SIGKILL')
  })
  const page = await context.newPage()
  await page.goto(`${appOrigin}/auth/google`)
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await page.waitForURL((url) => url.origin === providerOrigin)
  await page.locator('#ok').click({ noWaitAfter: true })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const names = ['outpost_refresh', '__Host-outpost_auth_context']
    const cookies = await context.cookies(appOrigin + '/api/v1/auth/refresh')
    if (names.every((name) => cookies.some((cookie) => cookie.name === name))) {
      process.send?.({ type: 'cookie' })
      await new Promise((resolve) => browserProcess.once('exit', resolve))
      process.disconnect?.()
      break
    }
    await delay(50)
  }
  if (browserProcess.signalCode === null && browserProcess.exitCode === null) {
    throw new Error('Activation cookie not observed')
  }
} catch (error) {
  process.send?.({ type: 'error', message: error.message.split('\n')[0] })
  browserProcess.kill('SIGKILL')
  process.disconnect?.()
  process.exitCode = 1
}
