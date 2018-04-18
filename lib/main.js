const path   = require('path')
const util   = require('util')
const os     = require('os')
const fs     = require('fs-extra')
const tar    = require('tar')
const axios  = require('axios')
const uglify = require('uglify-es')
const downloadYue = require('download-yue')

const {spawnSync} = require('child_process')
const {PassThrough, Transform} = require('stream')
const {streamPromise, ignoreError, cat} = require('./util')

const checkLicense = util.promisify(require('license-checker').init)
const createPackage = util.promisify(require('asar').createPackageWithOptions)

const ignore = [
  'build/*',
  '**/*.md',
  '**/*.ts',
  '**/*.map',
  '**/*.bak',
  '**/docs/**',
  '**/support/**',
  '**/test/**',
  '**/tests/**',
  '**/coverage/**',
  '**/examples/**',
  '**/.github/**',
  '**/.vscode/**',
  '**/.travis.yml',
  '**/.npmignore',
  '**/.editorconfig',
  '**/.jscs.json',
  '**/.jshintrc',
  '**/.nvmrc',
  '**/.eslintrc',
  '**/.eslintrc.json',
  '**/.eslintignore',
  '**/.uglifyjsrc.json',
  '**/tslint.json',
  '**/tsconfig.json',
  '**/Gruntfile.js',
  '**/bower.json',
  '**/package-lock.json',
  '**/badges.html',
  '**/test.html',
  '**/Makefile',
  '**/LICENSE',
  '**/License',
  '**/license',
  '**/TODO',
]

// Minimize js file.
function transform(rootDir, p) {
  if (!p.endsWith('.js'))
    return new PassThrough()
  let data = ''
  return new Transform({
    transform(chunk, encoding, callback) {
      data += chunk
      callback(null)
    },
    flush(callback) {
      const result = uglify.minify(data, {parse: {bare_returns: true}})
      if (result.error) {
        const rp = path.relative(rootDir, p)
        const message = `${result.error.message} at line ${result.error.line} col ${result.error.col}`
        console.error(`Failed to minify ${rp}:`, message)
        callback(null, data)
      } else {
        callback(null, result.code)
      }
    }
  })
}

// Parse the packageJson and generate app information.
function getAppInfo(packageJson) {
  const appInfo = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
  }
  if (packageJson.build && packageJson.build.appId)
    appInfo.appId = packageJson.build.appId
  else
    appInfo.appId = `com.${packageJson.name}.${packageJson.name}`
  if (packageJson.build && packageJson.build.productName)
    appInfo.productName = packageJson.build.productName
  else
    appInfo.productName = packageJson.name
  if (packageJson.build && packageJson.build.copyright)
    appInfo.copyright = packageJson.build.copyright
  else
    appInfo.copyright = `Copyright © ${(new Date()).getYear()} ${appInfo.productName}`
  return appInfo
}

// Download and unzip Yode into cacheDir.
async function downloadYode(version, platform, arch, cacheDir) {
  const name = `yode-${version}-${platform}-${arch}`
  const filename = `${name}.zip`
  const targetDir = path.join(cacheDir, name)
  const yodePath = path.join(targetDir, platform == 'win32' ? 'yode.exe' : 'yode')
  if (await fs.pathExists(yodePath))
    return yodePath
  try {
    await downloadYue('yode', version, filename, targetDir)
    await fs.chmod(yodePath, 0o755)
  } catch(e)  {
    await ignoreError(fs.remove(targetDir))
    throw e
  }
  return yodePath
}

// Get latest version of Yode.
async function getLatestYodeVersion(cacheDir, timeout = 600000) {
  const cache = path.join(cacheDir, 'yode-latest-release')

  if (await fs.pathExists(cache)) {
    try {
      const release = await fs.readJson(cache)
      if (release.time + timeout > Date.now()) {
        return release.tag_name
      }
    } catch (err) {
      // Do nothing
    }
  }

  const release = await axios.get('https://api.github.com/repos/yue/yode/releases/latest')
  await fs.ensureFile(cache)
  await fs.writeJson(cache, {tag_name: release.data.tag_name, time: Date.now()})
  return release.data.tag_name
}

// Copy the app into a dir and install production dependencies.
async function installApp(appDir, platform, arch) {
  const immediateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yacakge-'))
  const freshDir = path.join(immediateDir, 'package')
  try {
    // cd appDir && npm pack
    const pack = spawnSync('npm', ['pack'], {shell: true, cwd: appDir}).output[1]
    const tarball = path.join(appDir, pack.toString().trim())
    try {
      // cd immediateDir && tar xf tarball
      await tar.x({file: tarball, cwd: immediateDir})
    } finally {
      await ignoreError(fs.remove(tarball))
    }
    // cd immediateDir && npm install --production
    const env = Object.create(process.env)
    env.npm_config_platform = platform
    env.npm_config_arch = arch
    env.yackage = 'true'
    spawnSync('npm', ['install', '--production'], {shell: true, cwd: freshDir, env})
  } catch(e) {
    await ignoreError(fs.remove(immediateDir))
    throw e
  }
  return freshDir
}

// Append ASAR meta information at end of target.
async function appendMeta(target) {
  const stat = await fs.stat(target)
  const meta = Buffer.alloc(8 + 1 + 4)
  const asarSize = stat.size + meta.length
  meta.writeDoubleLE(asarSize, 0)
  meta.writeUInt8(2, 8)
  meta.write('ASAR', 9)
  await fs.appendFile(target, meta)
}

// Collect licenses.
async function writeLicenseFile(outputDir, freshDir) {
  let license = ''
  const data = await checkLicense({start: freshDir})
  for (const name in data) {
    const info = data[name]
    license += name + '\n'
    if (info.publisher)
      license += info.publisher + '\n'
    if (info.email)
      license += info.email + '\n'
    if (info.url)
      license += info.url + '\n'
    const content = await fs.readFile(info.licenseFile)
    license += '\n' + content.toString().replace(/\r\n/g, '\n')
    license += '\n' + '-'.repeat(70) + '\n\n'
  }
  await fs.writeFile(path.join(outputDir, 'LICENSE'), license)
}

// Package the app with Yode.
async function packageApp(outputDir, appDir, options, version, platform, arch, cacheDir) {
  const appInfo = getAppInfo(await fs.readJson(path.join(appDir, 'package.json')))
  let target = path.join(outputDir, platform === 'win32' ? `${appInfo.name}.exe` : appInfo.name)
  const yodePath = await downloadYode(version, platform, arch, cacheDir)
  const freshDir = await installApp(appDir, platform, arch)
  const intermediate = path.join(outputDir, 'app.ear')
  try {
    const asarOpts = {
      transform: transform.bind(this, freshDir),
      unpack: options.unpack,
      globOptions: {ignore}
    }
    await createPackage(freshDir, intermediate, asarOpts)
    await appendMeta(intermediate)
    await fs.ensureDir(outputDir)
    if (platform === 'win32')
      await require('./win').modifyExe(yodePath, appInfo, appDir)
    await cat(target, yodePath, intermediate)
    await fs.chmod(target, 0o755)
    await writeLicenseFile(outputDir, freshDir)
    const resDir = path.join(outputDir, 'res')
    await ignoreError(fs.remove(resDir))
    await ignoreError(fs.rename(`${intermediate}.unpacked`, resDir))
  } finally {
    // Cleanup.
    await ignoreError(fs.remove(freshDir))
    await ignoreError(fs.remove(intermediate))
    await ignoreError(fs.remove(`${intermediate}.unpacked`))
  }
  if (platform === 'darwin')
    target = await require('./mac').createBundle(appInfo, appDir, outputDir, target)
  return target
}

module.exports = {downloadYode, getLatestYodeVersion, packageApp}
