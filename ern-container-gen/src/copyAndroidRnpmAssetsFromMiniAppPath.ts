import { handleCopyDirective, readPackageJsonSync } from 'ern-core'
import path from 'path'

export function copyAndroidRnpmAssetsFromMiniAppPath(
  miniAppPath: string,
  outputPath: string
) {
  const packageJson = readPackageJsonSync(miniAppPath)
  if (packageJson.rnpm && packageJson.rnpm.assets) {
    for (const assetDirectoryName of packageJson.rnpm.assets) {
      const source = path.join(assetDirectoryName, '*')
      const dest = path.join(
        'lib',
        'src',
        'main',
        'assets',
        assetDirectoryName.toLowerCase()
      )
      handleCopyDirective(miniAppPath, outputPath, [{ source, dest }])
    }
  }
}
