import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import semver from 'semver'
import { manifest } from './Manifest'
import * as ModuleTypes from './ModuleTypes'
import { PackagePath } from './PackagePath'
import Platform from './Platform'
import { reactnative, yarn } from './clients'
import config from './config'
import createTmpDir from './createTmpDir'
import log from './log'
import {
  findNativeDependencies,
  NativeDependencies,
} from './nativeDependenciesLookup'
import shell from './shell'
import * as utils from './utils'
import { readPackageJson, writePackageJson } from './packageJsonFileUtils'
import { packageCache } from './packageCache'
import kax from './kax'
import { BaseMiniApp } from './BaseMiniApp'
import _ from 'lodash'

const npmIgnoreContent = `ios/
android/
yarn.lock
.flowconfig
.buckconfig
.gitattributes
.watchmanconfig
`

export class MiniApp extends BaseMiniApp {
  // Session cache
  public static miniAppFsPathByPackagePath = new Map<string, string>()

  public static fromCurrentPath() {
    return MiniApp.fromPath(process.cwd())
  }

  public static fromPath(fsPath: string) {
    return new MiniApp(fsPath, PackagePath.fromString(fsPath))
  }

  public static existInPath(p) {
    // Need to improve this one to check in the package.json if it contains the
    // ern object with miniapp type
    return fs.existsSync(path.join(p, 'package.json'))
  }

  public static async fromPackagePath(packagePath: PackagePath) {
    let fsPackagePath
    if (
      config.getValue('package-cache-enabled', true) &&
      !packagePath.isFilePath &&
      !(await utils.isGitBranch(packagePath))
    ) {
      if (!(await packageCache.isInCache(packagePath))) {
        fsPackagePath = await packageCache.addToCache(packagePath)
      } else {
        fsPackagePath = await packageCache.getObjectCachePath(packagePath)
      }
    } else {
      if (this.miniAppFsPathByPackagePath.has(packagePath.fullPath)) {
        fsPackagePath = this.miniAppFsPathByPackagePath.get(
          packagePath.fullPath
        )
      } else {
        fsPackagePath = createTmpDir()
        shell.pushd(fsPackagePath)
        try {
          await yarn.init()
          await yarn.add(packagePath)
          const packageJson = await readPackageJson('.')
          const packageName = Object.keys(packageJson.dependencies)[0]
          shell.rm(path.join(fsPackagePath, 'package.json'))
          shell.mv(
            path.join(fsPackagePath, 'node_modules', packageName, '*'),
            fsPackagePath
          )
          shell.rm(
            '-rf',
            path.join(fsPackagePath, 'node_modules', packageName, '*')
          )
        } finally {
          shell.popd()
        }
      }
    }
    this.miniAppFsPathByPackagePath.set(packagePath.fullPath, fsPackagePath)
    return new MiniApp(fsPackagePath, packagePath)
  }

  public static async create(
    miniAppName: string,
    packageName: string,
    {
      platformVersion = Platform.currentVersion,
      scope,
    }: {
      platformVersion: string
      scope?: string
    }
  ) {
    if (fs.existsSync(path.join('node_modules', 'react-native'))) {
      throw new Error(
        'It seems like there is already a react native app in this directory. Use another directory.'
      )
    }

    if (Platform.currentVersion !== platformVersion) {
      Platform.switchToVersion(platformVersion)
    }

    let reactNativeVersion
    const retrieveRnManifestTask = kax.task(
      'Querying Manifest for react-native version to use'
    )

    try {
      const reactNativeDependency = await manifest.getNativeDependency(
        PackagePath.fromString('react-native')
      )

      if (!reactNativeDependency) {
        throw new Error(
          'react-native dependency is not defined in manifest. cannot infer version to be used'
        )
      }

      reactNativeVersion = reactNativeDependency.version
      if (!reactNativeVersion) {
        throw new Error('React Native version needs to be explicitely defined')
      }
      retrieveRnManifestTask.succeed(
        `Retrieved react-native version from Manifest [${reactNativeVersion}]`
      )
    } catch (e) {
      retrieveRnManifestTask.fail()
      throw e
    }

    await kax
      .task(
        `Creating ${miniAppName} project using react-native v${reactNativeVersion}`
      )
      .run(reactnative.init(miniAppName, reactNativeVersion))

    // Create .npmignore
    const npmIgnorePath = path.join(process.cwd(), miniAppName, '.npmignore')
    fs.writeFileSync(npmIgnorePath, npmIgnoreContent)

    // Inject ern specific data in MiniApp package.json
    const pathToMiniApp = path.join(process.cwd(), miniAppName)
    const appPackageJson = await readPackageJson(pathToMiniApp)
    appPackageJson.ern = {
      moduleName: miniAppName,
      moduleType: ModuleTypes.MINIAPP,
      version: platformVersion,
    }
    appPackageJson.private = false
    appPackageJson.keywords
      ? appPackageJson.keywords.push(ModuleTypes.MINIAPP)
      : (appPackageJson.keywords = [ModuleTypes.MINIAPP])

    if (scope) {
      appPackageJson.name = `@${scope}/${packageName}`
    } else {
      appPackageJson.name = packageName
    }

    await writePackageJson(pathToMiniApp, appPackageJson)

    // Remove react-native generated android and ios projects
    // They will be replaced with our owns when user uses `ern run android`
    // or `ern run ios` command
    const miniAppPath = path.join(process.cwd(), miniAppName)
    shell.pushd(miniAppPath)
    try {
      shell.rm('-rf', 'android')
      shell.rm('-rf', 'ios')

      if (semver.gte(reactNativeVersion, '0.49.0')) {
        // Starting from React Native v0.49.0, the generated file structure
        // is different. There is just a single `index.js` and `App.js` in
        // replacement of `index.ios.js` and `index.android.js`
        // To keep backard compatibility with file structure excpected by
        // Electrode Native, we just create `index.ios.js` and `index.android.js`
        shell.cp('index.js', 'index.ios.js')
        shell.cp('index.js', 'index.android.js')
        shell.rm('index.js')
      }

      return MiniApp.fromPath(miniAppPath)
    } finally {
      shell.popd()
    }
  }

  constructor(miniAppPath: string, packagePath: PackagePath) {
    super({ miniAppPath, packagePath })
  }

  public async getNativeDependencies(): Promise<NativeDependencies> {
    return findNativeDependencies(path.join(this.path, 'node_modules'))
  }

  // Return all javascript (non native) dependencies currently used by the MiniApp
  // This method checks dependencies from the package.json of the MiniApp and
  // exclude native dependencies (plugins).
  public async getJsDependencies(): Promise<PackagePath[]> {
    const nativeDependencies: NativeDependencies = await this.getNativeDependencies()
    const nativeDependenciesNames: string[] = _.map(
      nativeDependencies.all,
      d => d.packagePath.basePath
    )
    const nativeAndJsDependencies = this.getPackageJsonDependencies()

    return _.filter(
      nativeAndJsDependencies,
      d => !nativeDependenciesNames.includes(d.basePath)
    )
  }

  public async addDependency(
    dependency: PackagePath,
    { dev, peer }: { dev?: boolean; peer?: boolean } = {}
  ): Promise<PackagePath | void> {
    if (!dependency) {
      return log.error('dependency cant be null')
    }
    if (dev || peer) {
      // Dependency is a devDependency or peerDependency
      // In that case we don't perform any checks at all (for now)
      await this.addDevOrPeerDependency(dependency, dev)
    } else {
      // Dependency is not a development dependency
      // In that case we need to perform additional checks and operations
      const basePathDependency = new PackagePath(dependency.basePath)
      const manifestNativeDependency = await manifest.getNativeDependency(
        basePathDependency
      )
      const manifestDependency =
        manifestNativeDependency ||
        (await manifest.getJsDependency(basePathDependency))

      if (!manifestDependency) {
        // Dependency is not declared in manifest
        // We need to detect if this dependency is a pure JS one or if it's a native one or
        // if it contains transitive native dependencies
        const tmpPath = createTmpDir()
        process.chdir(tmpPath)
        await kax
          .task(
            `${basePathDependency.toString()} is not declared in the manifest. Performing additional checks.`
          )
          .run(yarn.add(PackagePath.fromString(dependency.toString())))

        const nativeDependencies = await findNativeDependencies(
          path.join(tmpPath, 'node_modules')
        )
        if (_.isEmpty(nativeDependencies.all)) {
          log.debug('Pure JS dependency')
          // This is a pure JS dependency. Not much to do here -yet-
        } else if (nativeDependencies.all.length >= 1) {
          log.debug(
            `One or more native dependencies identified: ${JSON.stringify(
              nativeDependencies.all
            )}`
          )
          let dep
          for (dep of nativeDependencies.all) {
            if (
              dependency.same(new PackagePath(dep.packagePath.basePath), {
                ignoreVersion: true,
              })
            ) {
              if (
                await utils.isDependencyApiOrApiImpl(dep.packagePath.basePath)
              ) {
                log.debug(`${dep.packagePath.toString()} is an api or api-impl`)
                log.warn(
                  `${dep.packagePath.toString()} is not declared in the Manifest. You might consider adding it.`
                )
              } else {
                // This is a third party native dependency. If it's not in the master manifest,
                // then it means that it is not supported by the platform yet. Fail.
                return log.error(
                  `${dep.packagePath.toString()} plugin is not yet supported. Consider adding support for it to the master manifest`
                )
              }
            } else {
              // This is a dependency which is not native itself but contains a native dependency as  transitive one (example 'native-base')
              // If ern platform contains entry in the manifest but dependency versions do not align, report error
              const manifestDep = await manifest.getNativeDependency(
                new PackagePath(dep.packagePath.basePath)
              )
              if (manifestDep) {
                if (
                  !dep.packagePath.same(manifestDep, { ignoreVersion: false })
                ) {
                  throw new Error(
                    `[Transitive Dependency] ${dep.packagePath.toString()} was not added to the MiniApp`
                  )
                }
              }
            }
          }
        }
      } else {
        if (dependency.version) {
          log.debug(
            `Dependency:${dependency.toString()} defined in manifest, performing version match`
          )
          // If the dependency & manifest version differ, log error and exit
          if (!dependency.same(manifestDependency, { ignoreVersion: false })) {
            throw new Error(
              `${dependency.toString()} was not added to the MiniApp`
            )
          }
        }
      }

      // Checks have passed add the dependency
      process.chdir(this.path)
      await kax
        .task(
          `Adding ${
            manifestDependency
              ? manifestDependency.toString()
              : dependency.toString()
          } to ${this.name}`
        )
        .run(
          yarn.add(
            manifestDependency || PackagePath.fromString(dependency.toString())
          )
        )
      return manifestDependency ? manifestDependency : dependency
    }
  }

  /**
   * Perform checks to ensure that proper dependency version is picked based on manifest entry.
   *
   * @param dependency dependency to be added
   * @param manifestDependency dependency defined in manifest
   * @returns {Dependency} Dependency with proper version number
   */
  public manifestConformingDependency(
    dependency: PackagePath,
    manifestDependency: PackagePath
  ): PackagePath | void {
    if (
      !dependency.version ||
      dependency.version === manifestDependency.version
    ) {
      // If no version was specified for this dependency, we're good, just use the version
      // declared in the manifest
      return manifestDependency
    } else {
      // Dependency version mismatch. Let the user know of potential impacts and suggest user to
      // updat the version in the manifest
      // TODO : If not API/API impl, we need to ensure that plugin is supported by platform
      // for the provided plugin version
      log.warn(`${dependency.toString()} version mismatch.`)
      log.warn(`Manifest version: ${manifestDependency.version || 'undefined'}`)
      log.warn(`Wanted version: ${dependency.version || 'undefined'}`)
      log.warn(
        `You might want to update the version in your Manifest to add this dependency to ${
          this.name
        }`
      )
      return dependency
    }
  }

  public async upgradeToPlatformVersion(
    versionToUpgradeTo: string
  ): Promise<any> {
    // Update all modules versions in package.json
    const manifestDependencies = await manifest.getJsAndNativeDependencies(
      versionToUpgradeTo
    )

    for (const manifestDependency of manifestDependencies) {
      if (this.packageJson.dependencies[manifestDependency.basePath]) {
        const dependencyManifestVersion = manifestDependency.version
        const localDependencyVersion = this.packageJson.dependencies[
          manifestDependency.basePath
        ]
        if (dependencyManifestVersion !== localDependencyVersion) {
          log.info(
            `${
              manifestDependency.basePath
            } : ${localDependencyVersion} => ${dependencyManifestVersion}`
          )
          this.packageJson.dependencies[
            manifestDependency.basePath
          ] = dependencyManifestVersion
        }
      }
    }

    // Update ernPlatformVersion in package.json
    if (!this.packageJson.ern) {
      throw new Error(`In order to upgrade, please first replace "ernPlatformVersion" : "${
        this.packageJson.ernPlatformVersion
      }" in your package.json 
with "ern" : { "version" : "${this.packageJson.ernPlatformVersion}" } instead`)
    }

    this.packageJson.ern.version = versionToUpgradeTo

    // Write back package.json
    const appPackageJsonPath = path.join(this.path, 'package.json')
    fs.writeFileSync(
      appPackageJsonPath,
      JSON.stringify(this.packageJson, null, 2)
    )

    process.chdir(this.path)
    await kax.task('Running yarn install').run(yarn.install())
  }

  public publishToNpm() {
    execSync(`npm publish --prefix ${this.path}`)
  }

  public async link() {
    const miniAppsLinks = config.getValue('miniAppsLinks', {})
    const previousLinkPath = miniAppsLinks[this.packageJson.name]
    if (previousLinkPath && previousLinkPath !== this.path) {
      log.warn(
        `Replacing previous link [${
          this.packageJson.name
        } => ${previousLinkPath}]`
      )
    } else if (previousLinkPath && previousLinkPath === this.path) {
      return log.warn(
        `Link is already created for ${this.packageJson.name} with same path`
      )
    }
    miniAppsLinks[this.packageJson.name] = this.path
    config.setValue('miniAppsLinks', miniAppsLinks)
    log.info(
      `${this.packageJson.name} link created [${this.packageJson.name} => ${
        this.path
      }]`
    )
  }

  public async unlink() {
    const miniAppsLinks = config.getValue('miniAppsLinks', {})
    if (miniAppsLinks[this.packageJson.name]) {
      delete miniAppsLinks[this.packageJson.name]
      config.setValue('miniAppsLinks', miniAppsLinks)
      log.info(`${this.packageJson.name} link was removed`)
    } else {
      return log.warn(`No link exists for ${this.packageJson.name}`)
    }
  }

  private async addDevOrPeerDependency(
    dependency: PackagePath,
    dev: boolean | undefined
  ) {
    const depPath = PackagePath.fromString(dependency.toString())
    if (dev) {
      await kax
        .task(`Adding ${dependency.toString()} to MiniApp devDependencies`)
        .run(yarn.add(depPath, { dev: true }))
    } else {
      await kax
        .task(`Adding ${dependency.toString()} to MiniApp peerDependencies`)
        .run(yarn.add(depPath, { peer: true }))
    }
  }
}
