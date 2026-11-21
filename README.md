# Spinframe

Spinframe reconstructs a 3D hand skeleton and pen axis from penspinning footage. It runs locally in Chrome or Edge. Video frames and recordings stay on the device.

## Start

On Windows, double-click **Launch Spinframe.cmd** with Node.js 20 or newer installed. Keep its console open while using the app. You can also start it from this directory:

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd start
```

Open [http://localhost:4173](http://localhost:4173). Installation and model setup need a network connection once. The app runs offline after setup. The local server exposes only the app, its runtime, and supported videos in this workspace’s `video clips` folder.

## Reconstruct a clip

1. Drop one or more videos, add a file from **Workspace clips**, or select **Record webcam** and stop the recording when you are done.
2. Match **Analysis rate** to the capture rate. A higher sample rate cannot recover frames that the camera missed.
3. Select **Reconstruct motion**. Each independent clip gets its own animation. Select an imported clip to switch results.
4. Scrub or slow down the animation. Drag to orbit and scroll to zoom. The source preview displays the detected hand and pen over the original clip.
5. If the tracker follows a finger, sleeve, or background line, scrub to a sharp frame in the source preview, choose **Mark pen tips**, and click both tips. Repeat where needed, then run reconstruction again.

The viewer distinguishes detected, user-marked, interpolated, and unavailable pen samples. Severe blur or finger occlusion can leave gaps, and a plausible-looking detection can still be wrong. A single view gives approximate depth in palm-width units. A symmetric pen can have ambiguous tip identity, and axial roll is not estimated. **Export JSON** saves timestamps, 3D hand joints and pen tips, and the pen position and direction in a wrist-centered palm frame where both tracks are present.

## Reconstruct one take from several cameras

Import synchronized camera recordings of the same take and load a calibration file under **Synchronized cameras**. A downloadable example is available in the app. Use the exact clip filenames, undistorted recordings, and each camera's `K[R|t]` projection matrix in the original video’s pixel coordinates. Use a common world coordinate system with positive camera depth. `offsetSeconds` is the time when that clip’s first frame appears on the shared clock.

Spinframe triangulates observations from at least two agreeing views and analyzes their common time interval. When marking tips across cameras, use the same tip order. The exported coordinates use the calibration’s world units.
