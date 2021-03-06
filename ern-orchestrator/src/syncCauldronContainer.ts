import {
  createTmpDir,
  NativeApplicationDescriptor,
  Platform,
  kax,
  log,
  PackagePath,
} from 'ern-core'
import { getActiveCauldron, CauldronNativeAppVersion } from 'ern-cauldron-api'
import { runCauldronContainerGen, runCaudronBundleGen } from './container'
import { runContainerTransformers } from './runContainerTransformers'
import { runContainerPublishers } from './runContainerPublishers'
import * as constants from './constants'
import path from 'path'
import semver from 'semver'
import _ from 'lodash'
import { runCauldronCompositeGen } from './composite'

export async function syncCauldronContainer(
  stateUpdateFunc: () => Promise<any>,
  napDescriptor: NativeApplicationDescriptor,
  commitMessage: string | string[],
  {
    containerVersion,
  }: {
    containerVersion?: string
  } = {}
) {
  if (!napDescriptor.platform) {
    throw new Error(`${napDescriptor} does not specify a platform`)
  }

  const platform = napDescriptor.platform
  const outDir = Platform.getContainerGenOutDirectory(platform)
  let cauldronContainerNewVersion
  let cauldron

  try {
    cauldron = await getActiveCauldron()

    // ================================================================
    // Set new Container version
    // ================================================================
    if (containerVersion) {
      cauldronContainerNewVersion = containerVersion
    } else {
      const napVersion: CauldronNativeAppVersion = await cauldron.getDescriptor(
        napDescriptor
      )
      cauldronContainerNewVersion = napVersion.detachContainerVersionFromRoot
        ? await cauldron.getContainerVersion(napDescriptor)
        : await cauldron.getTopLevelContainerVersion(napDescriptor)
      if (cauldronContainerNewVersion) {
        cauldronContainerNewVersion = semver.inc(
          cauldronContainerNewVersion,
          'patch'
        )
      } else {
        // Default to 1.0.0 for Container version
        cauldronContainerNewVersion = '1.0.0'
      }
    }

    // Begin a Cauldron transaction
    await cauldron.beginTransaction()

    // Trigger state change in Cauldron
    await stateUpdateFunc()

    // ================================================================
    // Generate Composite from Cauldron
    // ================================================================
    const compositeGenConfig = await cauldron.getCompositeGeneratorConfig(
      napDescriptor
    )
    const baseComposite = compositeGenConfig && compositeGenConfig.baseComposite

    const compositeDir = createTmpDir()

    const composite = await kax.task('Generating Composite from Cauldron').run(
      runCauldronCompositeGen(napDescriptor, {
        baseComposite,
        outDir: compositeDir,
      })
    )

    // ================================================================
    // Sync native dependencies in Cauldron with any changes of native
    // dependencies in Composite (new or updated native dependencies)
    // ================================================================
    const cauldronNativeDependencies = await cauldron.getNativeDependencies(
      napDescriptor
    )
    const compositeNativeDeps = await composite.getResolvedNativeDependencies()

    // Final native dependencies are the one that are in Composite
    // plus any extra ones present in the Cauldron that are not
    // in the Composite
    const extraCauldronNativeDependencies = _.differenceBy(
      cauldronNativeDependencies,
      compositeNativeDeps.resolved,
      'basePath'
    )
    const nativeDependencies = [
      ...extraCauldronNativeDependencies,
      ...compositeNativeDeps.resolved,
    ]
    await cauldron.syncContainerNativeDependencies(
      napDescriptor,
      nativeDependencies
    )

    // Generate Container from Cauldron
    await kax.task('Generating Container from Cauldron').run(
      runCauldronContainerGen(napDescriptor, composite, {
        outDir,
      })
    )

    // Update container version in Cauldron
    await cauldron.updateContainerVersion(
      napDescriptor,
      cauldronContainerNewVersion
    )

    // Update version of ern used to generate this Container
    await cauldron.updateContainerErnVersion(
      napDescriptor,
      Platform.currentVersion
    )

    // Update yarn lock and run Container transformers sequentially
    const pathToNewYarnLock = path.join(compositeDir, 'yarn.lock')
    await cauldron.addOrUpdateYarnLock(
      napDescriptor,
      constants.CONTAINER_YARN_KEY,
      pathToNewYarnLock
    )

    await runContainerTransformers({ napDescriptor, containerPath: outDir })

    // Commit Cauldron transaction
    await kax
      .task('Updating Cauldron')
      .run(cauldron.commitTransaction(commitMessage))

    log.info(
      `Added new container version ${cauldronContainerNewVersion} for ${napDescriptor} in Cauldron`
    )
  } catch (e) {
    log.error(`[syncCauldronContainer] An error occurred: ${e}`)
    if (cauldron) {
      cauldron.discardTransaction()
    }
    throw e
  }

  return runContainerPublishers({
    containerPath: outDir,
    containerVersion: cauldronContainerNewVersion,
    napDescriptor,
  })
}
