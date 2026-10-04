# Uno Q: manual and automatic photos on the laptop

The current rig is an Arduino **Uno Q** with a Logitech C920s connected through
an externally powered USB-C hub. The Uno Q's Linux side runs the camera code.
No Arduino sketch is needed for this transfer.

`--auto` keeps one camera process and one SSH connection open. After a single
two-second warmup, it selects a fresh frame approximately **once every second**
and saves its original JPEG plus metadata on the laptop. FFmpeg reads the
camera's native MJPEG output without decoding or re-encoding it. Up to 32 bytes
of camera buffer padding after a structurally validated JPEG end marker are
removed; the encoded image itself is unchanged. Python uses
only its standard library. **Neither manual nor automatic capture needs
OpenCV.** Manual `--once` / Enter-triggered capture uses the same FFmpeg MJPEG
reader, warms up for each new photo, and caches the photo on the board so a
transfer retry retrieves the same frame without opening the camera again.

## 1. Finish the hardware and network setup

1. Complete the Uno Q's initial Arduino App Lab setup, including its board
   password and Wi-Fi. Put the laptop on a network that lets it reach the board.
2. Connect the camera to a USB-A **data** port on the hub, the charger to the
   hub's PD input, and the hub's upstream USB-C lead to the Uno Q. Open the
   camera's privacy shutter. The hub needs data ports as well as PD passthrough.
3. Check the charger, cable, and hub can supply the board's specified 5 V / 3 A,
   with capacity for the camera and hub too. The laptop receives images over
   Wi-Fi; the hub is attached to the board as its host.
4. Find the board's IP/name in App Lab, then log in from the laptop:

```bash
ssh arduino@YOUR_BOARD_IP
```

Use your actual account if it differs from `arduino`. See Arduino's
[powered-hub setup](https://docs.arduino.cc/tutorials/uno-q/single-board-computer/),
[power guide](https://docs.arduino.cc/tutorials/uno-q/power-specification/), and
[SSH setup](https://docs.arduino.cc/tutorials/uno-q/ssh/).

## 2. Install tools on the board

Run these **inside the Uno Q SSH shell**:

```bash
sudo apt update
sudo apt install -y python3 ffmpeg v4l-utils usbutils
lsusb
v4l2-ctl --list-devices
v4l2-ctl --device=/dev/video0 --list-formats-ext
timedatectl status
```

Choose the Logitech video node that supports MJPG capture. The default requests
1920 x 1080 at 30 fps; the timer selects only one of those frames per second.
If that mode is unavailable, select a supported size with `--width` / `--height`.
A matching `/dev/v4l/by-id/...-video-index0` path is preferable when available.
The JPEG header supplies the actual saved dimensions. Check the board's clock
because its frame-receipt time is recorded in UTC.

If necessary, grant the board account video access and reconnect:

```bash
sudo usermod -aG video arduino
exit
```

Close other camera programs. This path requires a camera that provides MJPEG;
it does not silently choose a raw-video format. FFmpeg documents its Linux
camera input in its [device reference](https://ffmpeg.org/ffmpeg-devices.html#video4linux2_002c-v4l2).

## 3. Configure SSH once on the laptop

The laptop needs Python 3.9+ and OpenSSH. To start without setting up an SSH
key, use `--password` when running capture. SSH asks for the **Arduino/App Lab
board password**, not the UMICH Wi-Fi password. Automatic mode keeps the same
connection open, so you enter the password once per session. The initial
timeout allows two minutes for login and the first photo; subsequent transfers
retain the shorter stall timeout. No password is stored by the capture program.

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto --password
```

The default also permits a password prompt when no key is available. For
unattended capture, configure an SSH key using the steps below. Skip key
creation if this key exists; specify `--identity` for noninteractive use.

**Laptop, macOS/Linux:**

```bash
ssh-keygen -t ed25519 -f "$HOME/.ssh/scrap_unoq" -C 'scrap-uno-q'
ssh arduino@YOUR_BOARD_IP 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < "$HOME/.ssh/scrap_unoq.pub"
ssh-add "$HOME/.ssh/scrap_unoq"
ssh -i "$HOME/.ssh/scrap_unoq" -o IdentitiesOnly=yes -o BatchMode=yes arduino@YOUR_BOARD_IP 'hostname'
```

Verify the board's host key on the first SSH connection. Keep the private key
on the laptop. [ARDUINO.md](../../ARDUINO.md) includes Windows SSH-agent setup;
on Windows use `python` instead of `python3` below. The laptop does not need
FFmpeg or OpenCV.

## 4. Copy the current board script

Run from the **repository root on the laptop**. Copy the current repository
file again if the board still has the older manual script that required
OpenCV. It supports both capture modes.

```bash
ssh -i "$HOME/.ssh/scrap_unoq" arduino@YOUR_BOARD_IP 'mkdir -p scrap-camera'
scp -i "$HOME/.ssh/scrap_unoq" capture/uno-q/uno_q_camera.py arduino@YOUR_BOARD_IP:scrap-camera/uno_q_camera.py
ssh -i "$HOME/.ssh/scrap_unoq" arduino@YOUR_BOARD_IP '/usr/bin/python3 scrap-camera/uno_q_camera.py --help'
```

For password authentication, omit `-i "$HOME/.ssh/scrap_unoq"` from these
commands and enter the board password when prompted.

## 5. Capture every second

Run on the **laptop**, from the repository root:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto
```

The one-second interval is the default. To make it explicit:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto --interval 1
```

Press **Ctrl+C** to stop. For the initial hardware check, collect only five
photos and confirm they open and show changes in the camera view:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto --count 5
```

Alternative supported camera mode:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto --device /dev/video2 --width 1280 --height 720
```

Each complete capture is saved under:

```text
images/arduino-inbox/<capture-uuid>/photo.jpg
images/arduino-inbox/<capture-uuid>/metadata.json
```

The laptop validates the transfer's ID, byte count, checksum, dimensions,
timestamp, and ZIP contents before publishing a complete capture directory.
These local photos are gitignored. Camera stalls, failed SSH connections, and
incomplete transfers produce explicit errors. Empty FFmpeg camera packets are
skipped without creating a capture; 90 consecutive empty packets produce a
camera/device error. The C920 may append non-image bytes after a complete JPEG;
bounded padding is removed before checksumming and transfer. Missing lengths,
incorrect formats, oversized images, excessive trailing data, and malformed
or truncated JPEGs remain errors. Complete photos remain saved;
restart the command after resolving the problem. Automatic mode does not cache
frames on the board or recover a frame lost during transfer. Manual capture's
existing pending-ID/cache retry flow remains available, and a pending manual
capture must be resolved before automatic mode starts.

## 6. Capture manually

Run on the **laptop**, from the repository root, with no `--auto` flag:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --password
```

Press **Enter** for one photo and wait for `Saved` before replacing the dish.
Type **q** to quit. For a single capture and exit:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --password --once
```

Omit `--password` if you use the SSH key configured above. Manual mode starts
one SSH/FFmpeg session per request; password authentication can prompt for each
photo. Each new request consumes frames through its warmup and then keeps one
validated native JPEG. Camera stalls, malformed JPEGs, and repeated empty
packets fail explicitly, preserving the laptop's pending ID. Retry with the
same settings and dish in place. If the board already cached that ID, it sends
the cached photo without requiring FFmpeg or the camera to be available.

## Boundaries and verification

- This timer captures **frames**, not unique dishes. Metadata marks
  `triggerSource: interval` and `dishIdentity: unresolved`. A stationary plate
  can appear in many photos; do not ingest every frame as a different dish.
  Dish detection/tracking is a separate step.
- Timing is approximate, subject to camera, disk, and network speed. Missed
  slots are skipped, rather than followed by a burst of captures. Warmup runs
  once at startup. Use one program per output folder and monitor laptop disk
  space during long runs.
- Photos are raw and unnormalized. Keep the full plate within the centered
  square crop used by the existing 1024 x 1024 normalization adapter.
- This operation ends at local files. It does not upload to R2, mutate
  SpacetimeDB, call Gemini, or calculate waste. Use the existing backend storage
  flow when integrating selected dish captures.
- The only transport addition is an automatic stream envelope containing the
  bundle length and capture UUID; the JPEG/metadata bundle remains protocol v1.
  No shared application contract or package dependency changed.

Run simulated checks from the repository root:

```bash
python3 -B -m unittest discover -s capture/uno-q -v
```

The checks use fake FFmpeg/SSH processes plus a synthetic fixture JPEG, with
OpenCV imports blocked. They verify manual and timed captures, warmup, file
integrity, actual JPEG dimensions, bounded camera padding, locking,
interrupted transfers, and cached manual retries. They do not verify real
FFmpeg, the Uno Q, the C920s, hub power, Wi-Fi,
or live downstream uploads. Those require the hardware check above.
Current verification: all 57 simulated checks passed after the manual-mode
FFmpeg migration.

Hardware smoke check, 2026-10-03: the real Uno Q and C920 were reached over SSH.
The webcam supported MJPEG 1920 x 1080 at 30 fps on its capture node. One empty
startup packet and up to 31 bytes of trailing buffer padding were observed.
After the padding fix, five real photos were transferred in one session, decoded
successfully on the laptop, and had recorded intervals of 1.004-1.041 seconds.
Continuous capture, Ctrl+C, and restart were also checked on the real board;
all 11 smoke-test photos decoded successfully. The simulated suite passed
50 tests.
This verifies camera-to-local-file capture, not dish detection, normalization,
or downstream ingestion. Real photos remain gitignored and are not fixtures.
The new FFmpeg manual path still needs its own hardware smoke check.
