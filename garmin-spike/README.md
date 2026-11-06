# Garmin feasibility test

This Audio Content Provider uses the native Garmin player. **Sync Now** downloads one MP3 into the provider's media cache. **Play Test Clip** plays the clip once. It saves a bookmark on pause or stop and requests that position when reopened. **Test Next Track** offers two slots backed by the same cached file so you can check track skipping separately. The menu displays a count stored on the watch, and only a `SONG_EVENT_COMPLETE` callback increments it.

## Build on Windows

1. Open [Garmin's SDK page](https://developer.garmin.com/connect-iq/sdk/), download **Connect IQ SDK Manager** for Windows, and sign in to your Garmin account in SDK Manager.
2. In the **SDK** tab, download and activate the current SDK. In **Devices**, download **Forerunner 255s Music** (`fr255sm`). The profile should include `%APPDATA%\Garmin\ConnectIQ\Devices\fr255sm\compiler.json`.
3. In PowerShell 7, run the following from the repo root. The script checks the active SDK and looks for Java on `PATH`. This workspace also has temporary portable copies of SDK 9.3.0 and OpenJDK 21 under `.spike-tools`. On a fresh checkout, install a Java runtime such as OpenJDK 21 if `java -version` fails.

   ```powershell
   .\garmin-spike\build.ps1
   ```

   The default is a [30-second public MP3 sample](https://soniqtools.com/test-audio-files). To test your Cloudflare workflow on the first run, upload a short clip with your existing uploader, then use its direct HTTPS MP3 enclosure URL. A clip of 30–90 seconds gives you time to test the controls. Enter the URL locally when prompted.

   ```powershell
   $mp3 = Read-Host 'Direct HTTPS MP3 URL'
   .\garmin-spike\build.ps1 -Mp3Url $mp3
   ```

   Use a URL that the watch can fetch without a browser session. If it contains a signed query string, treat the resulting `.prg` as private because the URL is compiled into it. The spike reuses its cache on repeat syncs. Use a fresh install of this provider when switching sources so the prior clip cannot satisfy the new test.
4. The script creates and reuses `garmin-spike\developer_key.der` and writes `garmin-spike\bin\OUTBACK.prg`. Keep the local key for future builds. For VS Code, install Garmin's **Monkey C** extension, open `garmin-spike`, and run **Monkey C: Verify Installation**. Point the extension's developer-key setting at `developer_key.der`. The command-line build already creates the local source configuration VS Code uses.

## Sideload and run

1. On the watch, hold **UP** and open **System → About**. Record the software version and the compiler version printed by `build.ps1`.
2. Connect the watch with a USB data cable. In Windows File Explorer, open the watch's internal storage and copy `OUTBACK.prg` into `GARMIN\APPS`. Create an empty `OUTBACK.TXT` in `GARMIN\APPS\LOGS` before testing. Turn on file extensions in Explorer so the file is actually `OUTBACK.TXT`. Disconnect the watch after the copy completes. [Garmin sideloading](https://developer.garmin.com/connect-iq/connect-iq-basics/your-first-app/) · [Garmin device logging](https://developer.garmin.com/connect-iq/core-topics/debugging/)
3. If necessary, set up Wi-Fi under **UP → Connectivity → Wi-Fi → My Networks → Add Network** and pair headphones under **UP → Music → Headphones → Add New**. Turn off Bluetooth on the *phone* so the watch has Wi-Fi for the download and the headphones remain connected to the watch. [Forerunner Wi-Fi](https://www8.garmin.com/manuals/webhelp/GUID-676967A0-1B23-4384-9BC9-76F3D643F1C8/EN-US/GUID-A320BB2B-B192-4CDF-931E-52FC01144D1E.html) · [Forerunner headphones](https://www8.garmin.com/manuals/webhelp/GUID-676967A0-1B23-4384-9BC9-76F3D643F1C8/EN-US/GUID-8C79FD0B-518C-4249-8680-CBEA69FC05A7.html)
4. Hold **DOWN** to open music controls, then hold **UP → Music Providers → Out and Backlog → Sync Now**. The native provider picker uses “and” because the Garmin compiler rejects `&` in an application name. When sync completes, reopen the provider menu. **Play Test Clip** should be present. Note the initial **Completions** count. [Forerunner music controls](https://www8.garmin.com/manuals/webhelp/GUID-676967A0-1B23-4384-9BC9-76F3D643F1C8/EN-GB/GUID-DF018310-524F-4B2C-AD10-94D4CA28253B.html)
5. Go out of range of the saved Wi-Fi networks and keep the phone disconnected. From the watch face press **START → Run → START**. While the Run timer is active, hold **DOWN** to open music controls and use **Out and Backlog → Play Test Clip** from **Music Providers**. If the player opens paused, press Play. Listen through headphones. Pause partway through and reopen the provider menu. Note the **Saved at** time and the completion count. Select **Play Test Clip** again, listen for where the clip picks up, and let it finish. To check track skipping, reopen the menu, choose **Test Next Track**, press **Next Track** early, then pause the second slot before it finishes.
6. Return to the activity screen and **STOP → Save** the Run. Reopen the provider menu and record **Completions**. Power the watch off and back on, reopen the menu, and check the count again. When back on Wi-Fi, run **Sync Now** to confirm the sync delegate reads the persisted count.
7. Reconnect over USB and copy `GARMIN\APPS\LOGS\OUTBACK.TXT` to your PC. Look for `OBL download response=200`, `OBL resume requested=`, the `OBL song` lines, and the `OBL sync completions=` line after reboot. If the app crashes, also check `GARMIN\APPS\LOGS\CIQ_LOG.YAML` for the relevant entry.

| Action | Expected evidence to compare against the hardware |
| --- | --- |
| Pause and resume | Events `6` and `7`. Count stays at the baseline. |
| Reopen playback after pausing | The `OBL resume requested=` position matches **Saved at**. Audio resumes near the point you heard before pausing. |
| Next Track in test mode | Event `1`. Count stays the same and playback restarts from the second slot. If Next is disabled or produces no event, record that separately. |
| Natural end in regular mode | Event `4`. Count increases by one, the bookmark clears, and playback stops. |
| Reboot and Sync Now | Same count in the menu and sync log. |

An offline playback pass requires audible playback while a native Run is recording and a saved activity afterward. A completion pass also requires distinct callback evidence and persistence through reboot. Report the firmware, SDK, whether the source was Cloudflare or the sample, and the `OBL` lines. [Garmin song event values](https://developer.garmin.com/connect-iq/api-docs/Toybox/Media.html)

For a long MP3, pause after a recognizable spoken cue several minutes in, reopen playback, and compare the audible position with that cue. Repeat after rebooting while the bookmark is still set. Check the audio even if the displayed timestamp looks correct. [Garmin ActiveContent API](https://developer.garmin.com/connect-iq/api-docs/Toybox/Media/ActiveContent.html)

## Local verification

Connect IQ 9.3.0 compiled and signed `bin\OUTBACK.prg` for `fr255sm` after SDK Manager installed the device profile. The build used the workspace SDK copy (`-SdkPath .\.spike-tools\sdk`) because the sandbox could not write the compiler cache in the SDK Manager installation. The public test clip returned HTTP 200 with `audio/mpeg` and an MP3 header.

On the first build, **Sync Now** downloaded the clip and a Forerunner 255S Music played it. Pausing left the count at zero. Reopening from the menu restarted the clip. Finishing increased the count to one and playback continued into the duplicate test slot. The bookmark and single-slot playback need to be verified on the watch with the updated build.
