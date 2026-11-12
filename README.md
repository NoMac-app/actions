# NoMac Actions

Sign an iOS app, send it to TestFlight and submit it for App Review from a [NoMac CI](https://nomac.app/docs/ci) job (`runs-on: nomac`), with no Apple secret stored in GitHub. NoMac keeps the App Store Connect key and makes the profiles; the job's Mac gets only NoMac's CI certificate and the profiles of the bundle IDs you allowed, for that job.

```yaml
permissions:
  id-token: write
  contents: read
jobs:
  release:
    runs-on: nomac
    steps:
      - uses: actions/checkout@v5
      - uses: NoMac-app/actions/sign@v1
      - run: |
          xcodebuild archive -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath build/App.xcarchive -xcconfig "$NOMAC_XCCONFIG" ${NOMAC_BUILD_NUMBER:+CURRENT_PROJECT_VERSION=$NOMAC_BUILD_NUMBER}
          xcodebuild -exportArchive -archivePath build/App.xcarchive -exportPath build/export -exportOptionsPlist "$NOMAC_EXPORT_OPTIONS"
      - uses: NoMac-app/actions/testflight@v1
        with:
          ipa: build/export/App.ipa
```

Before the first run, on [nomac.app/dash/ci](https://nomac.app/dash/ci) (Signing from jobs):

1. Connect your Apple account on the Apple page, and make the **CI certificate** (one of your team's distribution certificates, with a key of its own).
2. **Allow the workflow**: the repository, the workflow file (`.github/workflows/release.yml`), the bundle IDs it may sign, and whether tags sign too.

Only that workflow file signs, on the repository's default branch (and its tags, if you allowed them), and only on a NoMac Mac. A pull request, another branch or a fork never does. Every step of an allowed job can read the keychain, so allow only workflows you trust: if a key ever leaks, revoke the CI certificate at Apple and your NoMac Macs keep signing with their own.

## sign

| Input | | Output and variable |
| --- | --- | --- |
| `path` | the project's folder (`.`) | `xcconfig`, `NOMAC_XCCONFIG` |
| `scheme` | when there are several | `export-options`, `NOMAC_EXPORT_OPTIONS` |
| `container` | the `.xcodeproj` or `.xcworkspace`, when there are several | `team-id`, `NOMAC_TEAM_ID`; `build-number`, `NOMAC_BUILD_NUMBER` |

## testflight

| Input | |
| --- | --- |
| `ipa` | the signed `.ipa` |
| `notes` | What to Test |
| `wait` | `sent` (Apple has the build; the default) or `testflight` |

Outputs: `upload-id`, `state`, and the build's `bundle-id`, `version` and `build-number` for the publish step.

The app needs its App Store Connect record, and its export compliance answered once (`ITSAppUsesNonExemptEncryption` in its Info.plist, or once from a NoMac Mac).

## publish

Submits a build already on App Store Connect for App Review. The job runs in a GitHub environment, and the step names the build:

```yaml
jobs:
  release:
    runs-on: nomac
    environment: app-store
    steps:
      # checkout, sign, archive and export as above
      - uses: NoMac-app/actions/testflight@v1
        id: testflight
        with:
          ipa: build/export/App.ipa
      - uses: NoMac-app/actions/publish@v1
        with:
          bundle-id: ${{ steps.testflight.outputs.bundle-id }}
          version: ${{ steps.testflight.outputs.version }}
          build: ${{ steps.testflight.outputs.build-number }}
```

| Input | |
| --- | --- |
| `bundle-id`, `version`, `build` | the build to submit |
| `resolve-rejection` | `true` when Apple rejected this version before: marks its review item fixed |
| `wait-minutes` | how long to wait for Apple to process the build (`30`) |

Outputs: `submission-id` (Apple's) and `state`.

It is off until you turn it on: on [nomac.app/dash/ci](https://nomac.app/dash/ci), allow the workflow with the environment its job uses, then turn on **Submit for App Review** beside it. In GitHub (Settings, Environments), the environment needs a required reviewer and Prevent self-review, so a reviewer other than the person who pushed approves each run; NoMac checks both when the switch is turned on and at each submission. GitHub offers required reviewers for public repositories on every plan, and for private repositories only on GitHub Enterprise. A job submits only a build of an allowed bundle ID that Apple has processed, with that version alone in the submission, and only a version set to be released by hand (Manually release this version, in App Store Connect): once Apple approves, it waits for you. A repository's jobs submit at most 5 builds a day, and the first from a workflow is emailed to the account's owner.
