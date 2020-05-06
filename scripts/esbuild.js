const childProcess = require('child_process')
const rimraf = require('rimraf')
const path = require('path')
const fs = require('fs')

const repoDir = path.dirname(__dirname)
const modDir = path.join(repoDir, 'src', 'esbuild')
const npmDir = path.join(repoDir, 'npm', 'esbuild')

exports.buildBinary = () => {
  const name = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
  childProcess.execSync(`go build -o ../../${name} ./main`, { cwd: modDir, stdio: 'ignore' })
  return path.join(repoDir, name)
}

exports.installForTests = dir => {
  // Create a fresh test directory
  rimraf.sync(dir, { disableGlob: true })
  fs.mkdirSync(dir)

  // Install the "esbuild" package
  const env = { ...process.env, ESBUILD_BIN_PATH_FOR_TESTS: exports.buildBinary() }
  const version = require(path.join(npmDir, 'package.json')).version
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  childProcess.execSync(`npm pack --silent "${npmDir}"`, { cwd: dir, stdio: 'inherit' })
  childProcess.execSync(`npm install --silent --no-audit --progress=false esbuild-${version}.tgz`, { cwd: dir, env, stdio: 'inherit' })

  // Evaluate the code
  return require(path.join(dir, 'node_modules', 'esbuild'))
}
