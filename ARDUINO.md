# Arduino Uno Q + Logitech C920s: photos on the laptop

**Manual and automatic capture:** both use FFmpeg and Python's standard
library on the Uno Q; **OpenCV is no longer required**. Omit `--auto` for
Enter-triggered photos, or add `--once` for a single capture.
[The camera-capture guide](capture/uno-q/README.md) covers both modes.
Copy the current board script again when upgrading an older installation.

This guide gets a photo from the Logitech C920s connected to the **Arduino Uno Q** onto your laptop. Press Enter on the laptop, wait a few seconds, and receive a JPEG plus a small metadata file. Once those files exist, your laptop can use the project's upload flow.

Use the checked-in Python programs linked below; this Markdown file itself does not install or start anything.

## 1. What we are building

```text
Logitech C920s
    │ USB-A
    ▼
Powered USB-C hub ◀── USB-C PD power supply
    │ USB-C
    ▼
Arduino Uno Q — Debian Linux, Python, FFmpeg
    │ Wi-Fi / local network, SSH
    ▼
Laptop — Python, saves photo.jpg + metadata.json
    │ your subsequent upload flow
    ▼
Cloudflare R2: image bytes
SpacetimeDB: durable image references, metadata, application records
```

The laptop requests each photo over SSH. The Uno Q opens the webcam, lets exposure/focus settle, captures a frame, and caches it before sending it back. A transfer retry uses the same capture ID and retrieves the cached photo. There is no continuously running camera server to configure.

**The camera program runs on the Uno Q's Linux processor. No Arduino sketch, GPIO wiring, serial-image protocol, or MCU Bridge code is required for this task.** The board's microcontroller can remain as configured. Arduino documents this separation between Linux applications and Arduino sketches in its [Debian guide](https://docs.arduino.cc/tutorials/uno-q/debian-guide/).

This guide stops at local files. It does not call Gemini, R2, SpacetimeDB, or the project backend.

## 2. Hardware and software checklist

| Item | Needed for |
| --- | --- |
| Arduino **Uno Q**, either RAM variant | Running the Linux camera program |
| Logitech C920s Pro HD Webcam | Capturing the dish |
| USB-C hub with USB-A data ports and **USB-C Power Delivery input** | Connecting the camera while powering the board |
| Suitable USB-C PD supply and cable | Supplying the board and peripherals |
| Laptop with Python **3.9+**, `ssh`, and `scp` | Triggering captures and receiving files |
| Shared reachable local network | SSH communication between board and laptop |
| Arduino App Lab | Initial board setup and network configuration |

Arduino specifies 5 V / 3 A for USB-C board power. Account for the hub and webcam as well; the hub's advertised charger rating is not necessarily the power it delivers to the board. Use a compatible externally powered PD hub. Arduino's manual excludes Apple dongles from its supported setup. See the [Uno Q manual](https://docs.arduino.cc/tutorials/uno-q/user-manual/) and [power specifications](https://docs.arduino.cc/tutorials/uno-q/power-specification/).

The C920s uses USB-A, and Logitech describes its webcams as standard UVC devices. Arduino supports USB cameras on the Uno Q. That supports this integration approach, but the exact camera/hub/board combination still needs the hardware checks below. [Logitech connection requirements](https://www.logitech.com/en-us/discover/a/setup-webcams-and-headsets), [Logitech UVC information](https://support.logi.com/hc/en-001/articles/360060226873-Capture-requirements).

## 3. Set up the board once

### 3.1 Complete Arduino App Lab setup

1. Install Arduino App Lab on the laptop from the [official Arduino software page](https://www.arduino.cc/en/software/).
2. Follow App Lab's first-run setup for the Uno Q, initially connected directly to the laptop with a USB-C data cable. Complete any required board setup/update before installing the scripts.
3. Give the board a recognizable name and connect it to Wi-Fi. Keep the Linux password you configured.
4. Put the laptop on the same reachable network. A small router or hotspot that permits devices to communicate is often easier at an event than campus/guest Wi-Fi.
5. Note the board's hostname or IP address. Arduino documents SSH after initial App Lab setup in its [SSH tutorial](https://docs.arduino.cc/tutorials/uno-q/ssh/).

The commands below assume the documented Linux account `arduino`. Substitute your actual account if different. `192.168.1.50` is an **example IP**, not the board's fixed address.

### 3.2 Connect the webcam and powered hub

After setup, run `sudo halt` in a board shell. Arduino recommends this command because ordinary power-off commands can cause the Uno Q to restart. For a headless connection, normally allow 10–15 seconds before disconnecting power. Some firmware/power configurations also restart after `halt`; follow Arduino's [shutdown instructions](https://docs.arduino.cc/tutorials/uno-q/debian-guide/) if that happens. Once the board is unpowered:

1. Plug the C920s into a USB-A **data** port on the hub.
2. Plug the PD power supply into the hub's PD input.
3. Plug the hub's host/upstream USB-C lead into the Uno Q's USB-C port.
4. Let the Uno Q boot, and open the camera's privacy shutter.

The laptop communicates over Wi-Fi while the Uno Q's USB-C port is occupied by the hub. Do not connect the laptop to a hub's downstream USB-A port as if it were a second host. An HDMI display and keyboard are optional; this guide runs without a display connected to the board. Arduino documents the hub/peripheral setup in its [single-board computer guide](https://docs.arduino.cc/tutorials/uno-q/single-board-computer/).

### 3.3 Verify SSH from the laptop

**Laptop — macOS/Linux terminal:**

```bash
UNO_TARGET='arduino@192.168.1.50'
ssh "$UNO_TARGET"
```

You can use `arduino@YOUR-BOARD-NAME.local` instead if hostname discovery works. Confirm the first connection's host key after checking that you are connecting to your own board, and enter the board's Linux password.

**Laptop — Windows PowerShell:**

```powershell
$UNO_TARGET = 'arduino@192.168.1.50'
ssh $UNO_TARGET
```

If Windows cannot find `ssh`/`scp`, install the Windows **OpenSSH Client** optional feature following [Microsoft's installation instructions](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse). If `python` is unavailable, install Python 3.9+ and make it available in your terminal. macOS/Linux commands below use `python3`; on Windows use `python` or `py -3`.

Once logged in, these commands run **on the Uno Q**:

```bash
whoami
hostname -I
timedatectl status
```

Check the board's clock. Metadata uses a UTC timestamp from the board when the selected frame is received; it is not a hardware exposure timestamp. Correct a wrong clock/network-time setup before collecting service data.

## 4. Install camera tools and find the device

Run these in the **Uno Q SSH shell**, not on the laptop:

```bash
sudo apt update
sudo apt install -y python3 ffmpeg v4l-utils usbutils
ffmpeg -version
lsusb
v4l2-ctl --list-devices
```

Find the Logitech camera's video devices. A webcam can expose more than one `/dev/video*` node; some nodes contain metadata rather than usable images. Inspect the candidate:

```bash
v4l2-ctl --device=/dev/video0 --all
v4l2-ctl --device=/dev/video0 --list-formats-ext
```

Choose the node supporting video capture and JPEG/MJPG. The scripts require native MJPEG and do not fall back to raw-video formats. Substitute it everywhere this guide uses `/dev/video0`. If available, a matching `/dev/v4l/by-id/...-video-index0` path provides a more stable name across reboots than a numbered node; verify that it belongs to the C920s.

The scripts request **1920 × 1080, MJPG, 30 fps**, then save one JPEG. Device drivers may negotiate a different size; the saved metadata records the actual frame dimensions. Check supported formats rather than assuming that requested settings were accepted. FFmpeg reads the native MJPEG frames without re-encoding them; actual dimensions come from the saved JPEG header. See its [Linux camera input reference](https://ffmpeg.org/ffmpeg-devices.html#video4linux2_002c-v4l2).

If the account cannot access the video device:

```bash
id
ls -l /dev/video0
sudo usermod -aG video arduino
exit
```

Reconnect with SSH after changing group membership. If your account has a different name, substitute it in `usermod`. Use the ordinary account to run the camera program.

An optional visual test, when a display is connected to the board, is `sudo apt install cheese`, then `cheese` from its desktop session. Close Cheese and any App Lab camera example before running our program. Arduino describes camera discovery in its [USB-camera instructions](https://docs.arduino.cc/tutorials/uno-q/debian-guide/).

## 5. Set up SSH authentication for repeated captures

Use `--password` to enter the board password for each manual photo, or configure a key once for repeated captures without password prompts. An explicit `--identity` uses noninteractive SSH.

**Laptop — macOS/Linux:**

```bash
UNO_TARGET='arduino@192.168.1.50'
UNO_KEY="$HOME/.ssh/scrap_unoq"
ssh-keygen -t ed25519 -f "$UNO_KEY" -C 'scrap-uno-q'
ssh "$UNO_TARGET" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < "$UNO_KEY.pub"
ssh-add "$UNO_KEY"
ssh -i "$UNO_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$UNO_TARGET" 'printf "SSH ready\n"'
```

Choose a passphrase when creating the key; `ssh-add` unlocks it in the SSH agent. If there is no agent in a Linux terminal, run `eval "$(ssh-agent -s)"` and then `ssh-add` again. Run these setup commands once, and reuse the key. Do not overwrite an existing key when `ssh-keygen` asks.

**Laptop — Windows PowerShell:**

```powershell
$UNO_TARGET = 'arduino@192.168.1.50'
$UNO_KEY = "$HOME/.ssh/scrap_unoq"
ssh-keygen -t ed25519 -f $UNO_KEY -C 'scrap-uno-q'
Get-Content "$UNO_KEY.pub" | ssh $UNO_TARGET 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

To use a passphrase-protected key, enable the Windows SSH agent once in an **administrator PowerShell**, as described in [Microsoft's key-management guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement):

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Then return to an ordinary PowerShell:

```powershell
ssh-add $UNO_KEY
ssh -i $UNO_KEY -o IdentitiesOnly=yes -o BatchMode=yes $UNO_TARGET 'printf "SSH ready\n"'
```

Continue only after the test prints `SSH ready`. Keep the private key on the laptop; only the `.pub` file goes to the board.

## 6. Use the repository programs

Use the current checked-in files rather than copying an older embedded version:

- [Board program: `capture/uno-q/uno_q_camera.py`](capture/uno-q/uno_q_camera.py)
- [Laptop program: `capture/uno-q/laptop_capture.py`](capture/uno-q/laptop_capture.py)

The board uses FFmpeg to consume native MJPEG frames during exposure/focus
warmup, validates the selected JPEG, reads its actual dimensions, and caches a
ZIP with the photo and metadata under `~/scrap-camera/captures/`. Diagnostics
go to stderr. Reusing a completed capture ID returns its saved bytes without
reopening the camera or requiring FFmpeg to be available. The laptop bounds
the board command with Debian's `timeout` utility.

The laptop uses only Python's standard library and SSH. It validates the
bundle's capture ID, byte count, timestamp, dimensions, and checksum before
publishing a complete local directory. Its pending ID survives a failed
transfer or program restart. Photos under `images/` remain gitignored.

## 7. Copy the board program to the Uno Q

Run from the **repository root on the laptop**. Use the target from SSH setup.

**macOS/Linux:**

```bash
UNO_TARGET='arduino@192.168.1.50'
UNO_KEY="$HOME/.ssh/scrap_unoq"
ssh -i "$UNO_KEY" "$UNO_TARGET" 'mkdir -p scrap-camera'
scp -i "$UNO_KEY" capture/uno-q/uno_q_camera.py "${UNO_TARGET}:scrap-camera/uno_q_camera.py"
ssh -i "$UNO_KEY" "$UNO_TARGET" '/usr/bin/python3 scrap-camera/uno_q_camera.py --help'
```

**Windows PowerShell:**

```powershell
$UNO_TARGET = 'arduino@192.168.1.50'
$UNO_KEY = "$HOME/.ssh/scrap_unoq"
ssh -i $UNO_KEY $UNO_TARGET 'mkdir -p scrap-camera'
scp -i $UNO_KEY capture/uno-q/uno_q_camera.py "${UNO_TARGET}:scrap-camera/uno_q_camera.py"
ssh -i $UNO_KEY $UNO_TARGET '/usr/bin/python3 scrap-camera/uno_q_camera.py --help'
```

The help output confirms that the file was deployed and Python can parse it. It does not confirm camera operation yet. The remote path is relative to the SSH account's home directory.

## 8. Take the first photo

Place one dish in view. Keep it still until the laptop prints `Saved`. The default includes about two seconds of focus/exposure warmup plus camera and network overhead.

**Laptop — macOS/Linux, repository root:**

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --once
```

**Laptop — Windows PowerShell, repository root:**

```powershell
python capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --once
```

Expected output looks like:

```text
Requesting 81d4497e-4b7e-4be6-984a-f34ca214f4e1 ...
Saved: /YOUR/PROJECT/images/arduino-inbox/81d4497e-4b7e-4be6-984a-f34ca214f4e1/photo.jpg
Metadata: /YOUR/PROJECT/images/arduino-inbox/81d4497e-4b7e-4be6-984a-f34ca214f4e1/metadata.json
Actual image: 1920 x 1080 pixels
```

Open the printed `photo.jpg` path in Finder/File Explorer. Confirm that it is the current dish, the shutter is open, and the image is usable. A checksum verifies transfer integrity; it does not prove correct focus, exposure, plate detection, or food-mask quality.

For repeated manual captures, omit `--once`:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50
```

Press Enter once for each new dish and wait for success before replacing it. Type `q` to quit. On Windows, use `python` instead of `python3`.

If your device is different or you need a smaller supported mode:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --device /dev/video2 --width 1280 --height 720 --once
```

Custom key and destination example:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --identity "$HOME/.ssh/scrap_unoq" --out images/arduino-inbox --once
```

Use the same target, device, dimensions, warmup, remote script, and output folder while retrying a pending request. Run one laptop capture program at a time for that folder. A fresh successful Enter press represents a new dish; the program does not automatically track dishes moving through the scene.

## 9. Output files and project handoff

Each successfully received capture has its own directory:

```text
images/arduino-inbox/
└── 81d4497e-4b7e-4be6-984a-f34ca214f4e1/
    ├── photo.jpg
    └── metadata.json
```

The metadata contains a transport capture UUID, UTC timestamp, actual width/height, camera device, raw-image status, byte length, and SHA-256. It is **local transport metadata**, not a SpacetimeDB row or a project `CaptureEvent` payload. The transport UUID is not the existing adapter's canonical event ID.

**Next stage: the inbox bridge.** `cd capture && npm run ingest-inbox -- --service <serviceId>` reads
this folder, groups frames into dishes, and submits one `source: 'camera'` capture per dish (normalize →
R2 upload → finalize → `POST /api/captures` → Gemini + SAM analysis → SpacetimeDB database `scrap`).
For tonight's camera run the service is today's dinner, `svc_hall-main_<YYYY-MM-DD>_dinner` (hall-local
date, America/Detroit), seeded with `cd backend && npm run seed -- --live-dinner`. See
[BRIDGE.md](BRIDGE.md).

| Local value | Use in the bridge |
| --- | --- |
| Full path to `photo.jpg` | The dish's representative frame, normalized before upload |
| `metadata.captureId` | Frame identity; the first frame's ID is the dish's stable retry key |
| `metadata.capturedAt` | Frame order and the event's `capturedAt` |
| `metadata.triggerSource` | `interval` (`--auto`) frames need dedupe; manual frames do not |
| Hall/service selected on the laptop | `--service`; never inferred from the camera |
| Raw width/height | Provenance; do not claim the raw photo is already normalized |

**No board?** `cd capture && npm run simulate-camera -- --count 3` writes `test2/` photos into this
same folder layout with the same metadata fields, labeled `captureSource: "simulated_camera"` (the
bridge then submits them as `replay`, not `camera`). See [BRIDGE.md](BRIDGE.md#run-it-without-the-board-simulate-camera).

**Keep the photo raw here.** The project's current normalization is a centered square crop resized to **1024 × 1024**. Fit the entire plate inside the centered square portion of the camera view so that this crop does not cut off leftovers. Keep camera height, angle, and framing consistent: the measurement is **pixels** (there is no plate-size calibration), so a plate closer to the camera reads as more waste.

**One plate in the middle.** The analysis counts only the **target dish**, the plate most centered and most fully in frame. Food on a neighbouring plate that is partly in view is dropped (the capture is flagged `neighbor_food_excluded`) and counted later when that plate is centered in its own capture. If no plate can be identified, nothing is clipped and the capture is flagged `target_dish_unavailable`. Center each plate under the camera before triggering.

The next stage should upload image bytes to **R2**, confirm the object upload, and then register its durable object reference and metadata in **SpacetimeDB**. Image bytes, base64, or ZIP bundles do not belong in SpacetimeDB. Use the backend's existing storage flow; do not put R2 or SpacetimeDB credentials into either camera-transfer script.

## 10. Retry behavior and retained photos

The laptop creates `.pending.json` before requesting a photo. The board saves `<captureId>.zip` before sending it. The laptop removes the pending record only after it has validated and saved the complete local result.

- If the board completed capture but the network transfer failed, retrying retrieves the same saved JPEG and timestamp.
- If the board never completed capture, retrying takes the first successful photo for that pending ID. **Keep the dish in place until success.**
- Quitting or restarting the laptop program preserves a pending request. Run it again with the same settings to resume.
- Repeatedly photographing a stationary dish after successful saves creates additional captures. The manual trigger is the dish-identity boundary for this prototype.
- A saved local photo is ready for upload; receiving it does not mean R2 or SpacetimeDB has been updated.

The board cache is under `~/scrap-camera/captures/` and is not automatically deleted. It is a temporary local capture cache, separate from the project's durable R2 storage. Check its size on the board with:

```bash
du -sh ~/scrap-camera/captures
df -h ~
```

After verifying the laptop copy and resolving any pending request, you may remove a **specific** transferred ZIP using its printed capture ID:

```bash
rm ~/scrap-camera/captures/81d4497e-4b7e-4be6-984a-f34ca214f4e1.zip
```

Do not delete cached pending photos; doing so removes the ability to retrieve the original frame. If intentionally abandoning a failed request, inspect the board cache first, decide whether to recover the photo, then remove only `images/arduino-inbox/.pending.json` on the laptop. The next trigger will mint a new capture ID. Retention automation is outside this guide.

## 11. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Board does not boot, or camera is absent from `lsusb` | Hub is externally powered, PD input is connected, hub upstream lead reaches the board, camera is in a data port, and supply/cable meet the board/hub requirements. |
| SSH connection times out | Correct board IP, both devices on a reachable network, no guest/client isolation or VPN routing issue. Try the IP instead of `.local`; use App Lab/board shell to inspect `hostname -I`. |
| `Permission denied (publickey,...)` | Run the batch-mode SSH readiness test. Verify the public key was installed for the right account, the chosen private key matches, and its passphrase is unlocked with `ssh-add`. |
| `Host key verification failed` | Connect manually and verify the board identity. If the board was reflashed, confirm that fact before replacing its old known-host entry. |
| `FFmpeg is not installed` | Run `sudo apt install ffmpeg` on the **board**. |
| `No module named cv2` | The board still has the old script. Copy the current `uno_q_camera.py` from this repository again; neither capture mode needs OpenCV. |
| Cannot open camera, black frame, or empty frame | Open shutter, choose the video-capture node, check membership in `video`, and close other camera applications. |
| SSH/camera exits with code `124`, or laptop times out | The bounded camera command stalled. Check camera/hub, close competing processes, then retry the pending ID. Lower the requested mode only after resolving/abandoning the pending request. |
| `Another capture is using the camera` | Wait for the current request or its 20-second timeout, then retry. Use one operator and capture program. |
| Different settings error | `.pending.json` records the previous settings. Resume using them; inspect/recover a cached photo before deliberately abandoning the request. |
| ZIP parse or JPEG checksum failure | Retry the same pending ID. Keep all board logs on stderr; do not add stdout banners to the board script or noninteractive shell startup files. Inspect the cached ZIP if repeated retries fail. |
| Image is smaller than requested | The driver negotiated another mode. Inspect `--list-formats-ext`; actual dimensions are printed and saved. |
| Image is blurry/dark or plate is clipped | Improve lighting/framing, hold the dish still, and allow warmup. Inspect the center-square framing used by project normalization. |
| Disk fills up | Check board cache and laptop inbox sizes. Remove only verified, transferred captures under an agreed retention policy. |

If event Wi-Fi prevents device-to-device access, use a hotspot/router that allows it, or connect the board through the hub's Ethernet port to the same reachable LAN as the laptop. SSH needs local connectivity; it does not require a cloud service to transfer photos. Initial software installation still needs package access.

## 12. Acceptance checks and verification status

Before using this in the demonstration:

1. The board is reachable over SSH with its webcam connected through the powered hub.
2. One `--once` command produces a JPEG that opens on the laptop and shows the current dish.
3. Three successful triggers produce three directories with different capture IDs.
4. During a capture, temporarily interrupt network connectivity, restore it, and rerun with the same settings. If the board completed the first capture, verify that its cached JPEG is reused and that only one completed laptop directory exists for that ID.
5. Disconnect the camera before a new trigger. Confirm an explicit error and pending ID rather than an empty successful photo. Reconnect, keep the intended dish present, and retry.
6. Confirm that the files remain after restarting the laptop program and that no R2/SpacetimeDB operation occurred just from receiving them.

**End-to-end hardware check:** `python3 capture/scripts/live_camera_test.py --target arduino@BOARD_IP --identity ~/.ssh/scrap_unoq --service svc_hall-main_<today>_dinner --spacetime-db scrap` runs the board checks, then the bridge against a running backend (BRIDGE.md §6). `--stage camera` needs no backend.

**Current verification:** The simulated suite uses fake FFmpeg and SSH with
OpenCV imports deliberately blocked. It covers manual and timed capture,
actual JPEG dimensions, warmup, missing/disconnected camera errors, empty and
malformed packets, bounded camera padding, cached transfer retries, locking,
and bundle validation. Run `python3 -B -m unittest discover -s capture/uno-q -v`
from the repository root. These checks do not exercise live hardware or
networking. [The camera-capture guide](capture/uno-q/README.md) records the
prior automatic-mode hardware smoke check; the new FFmpeg manual path still
needs its own hardware check.

Assumptions: Uno Q Debian image with FFmpeg, SSH, and GNU `timeout`, a reachable local network, a supported webcam video mode, sufficient local storage, one manual operator, and existing project normalization/upload integration after receipt. The scripts deliberately record raw photos and local provenance; they do not implement plate detection, conveyor triggering, automatic dish tracking, or image analysis.
