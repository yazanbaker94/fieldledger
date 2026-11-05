# FieldLedger for Android

FieldLedger is a native Kotlin and Jetpack Compose client. Open this directory as a project in Android Studio. The app uses the same Express API and PostgreSQL workspace model as the website. Each installation opens a separate demo session.

[Download the signed APK](https://github.com/yazanbaker94/fieldledger/releases/tag/android-v1.0) for Android 8.0 or later. The release connects to the hosted FieldLedger demo.

## Build and run

Use JDK 17 or newer, Android SDK Platform 37.2, and Android SDK Build Tools 36.0.0. Use an Android Studio version that supports Android Gradle Plugin 9.5, or run the included Gradle wrapper. A Pixel virtual device with Android 8.0 or later can run the app.

In Android Studio, let Gradle sync, select the `app` run configuration, choose a phone emulator, and press **Run**. The default build uses the hosted demo.

From PowerShell in this directory:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n video.swoop.fieldledger/.MainActivity
```

## Walk through a correction

1. In **Worker**, choose **Use 7 hours** and submit. Open the saved timecard using **Go to foreman**.
2. Choose **Return with a note**, fill the example note, and send it. Follow **Go to worker**, use eight hours, and resubmit.
3. Follow the corrected timecard back to **Foreman** and approve it. Open **Manager** to see the $400 posting take approved labour from $9,700 to $10,100 against the $10,000 budget.
4. Open **Workspace options** to refresh or reset the demo. Reset restores the sample crew and initial budget for this session.

## Use a local test backend

From the repository root, build and start the existing backend with a disposable PostgreSQL database. Set `APP_ORIGIN=http://10.0.2.2:3037` and `PORT=3037` when using the standard Android Emulator. The emulator maps `10.0.2.2` to the host loopback interface.

```powershell
.\gradlew.bat -PfieldLedgerApiUrl=http://10.0.2.2:3037 :app:assembleDebug :app:assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e fieldLedgerApiUrl http://10.0.2.2:3037 video.swoop.fieldledger.test/androidx.test.runner.AndroidJUnitRunner
```

The Android tests use isolated demo sessions. Keep the integration tests on a disposable database because they submit, approve, and reset sample timecards. Add `-e fieldLedgerScreenshots true` to capture the demo workflow on the device.

## Verification

Unit and emulator tests cover the correction workflow, the $400 posting, role and revision checks, and session recovery. The UI was also tested with larger text and system animations disabled.

Emulator captures are in [screenshots](screenshots). The [Cost Trail](screenshots/04-manager-posting.png) and [source record](screenshots/05-manager-source.png) show the same approved timecard.

## How the client works

Navigation Compose opens the role workspaces and individual timecards. A shared ViewModel exposes immutable workspace snapshots through StateFlow. Preferences DataStore persists the session and the request ID for a submission whose result could not be confirmed. The server validates role and version, calculates the posting in integer cents, and commits the approval with its audit event. The Cost Trail uses those committed amounts and honours the system animation setting.

The demo requires an API connection to open or change a workspace. If a refresh fails while the app is open, the last loaded snapshot remains visible and the app shows the error. The role switcher is part of the fictional demo.

[Android Gradle plugin compatibility](https://developer.android.com/build/releases/agp-9-5-0-release-notes) · [Compose Bill of Materials](https://developer.android.com/develop/ui/compose/bom)
