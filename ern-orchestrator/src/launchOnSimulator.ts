import { ios, kax, shell } from 'ern-core'
import { buildIosRunner } from './buildIosRunner'

export async function launchOnSimulator(pathToIosRunner: string) {
  const iPhoneSim = await ios.askUserToSelectAniPhoneSimulator()
  await kax
    .task('Killing all running Simulators')
    .run(ios.killAllRunningSimulators())
  await kax
    .task('Booting iOS Simulator')
    .run(ios.launchSimulator(iPhoneSim.udid))
  shell.pushd(pathToIosRunner)
  try {
    await kax
      .task('Building iOS Runner project')
      .run(buildIosRunner(pathToIosRunner, iPhoneSim.udid))
    await kax
      .task('Installing iOS Runner on Simulator')
      .run(
        ios.installApplicationOnSimulator(
          iPhoneSim.udid,
          `${pathToIosRunner}/build/Debug-iphonesimulator/ErnRunner.app`
        )
      )
    await kax
      .task('Launching Runner')
      .run(ios.launchApplication(iPhoneSim.udid, 'com.yourcompany.ernrunner'))
  } finally {
    shell.popd()
  }
}
