# The Hand

A rigged hand behind frosted glass, made with three.js (WebGPU + TSL).

- The glass blurs the hand based on its distance: sharp when pressed against it, soft and faint as it moves away.
- When the hand pushes through the glass, it stretches like lycra fabric (compute shaders).
- The index finger follows the mouse: the forearm twists, the wrist and knuckle fine-tune, and the fingers stretch out in a cascade as the cursor gets close to the fingertip.

## Setup
Download [Node.js](https://nodejs.org/en/download/).
Run the following commands:

``` bash
# Install dependencies (only the first time)
npm install

# Run the local server
npm run dev

# Build for production in the dist/ directory
npm run build
```

Add `#debug` to the URL to see every hand parameter and orbit the camera.

## Model
The rigged hand is `static/hand.glb`. The mesh is the hand and forearm of the realistic male body from [Human Base Meshes](https://www.blender.org/download/demo-files/) (Blender Studio, CC0), simplified.

- **Bones:** `forearm > hand > {thumb,index,middle,ring,pinky}_01..03`. On each bone, `+X` curls the finger toward the palm.
- **Pose:** controlled from `src/Hand.js`.
- **Rig:** generated with the Blender scripts in `recursos/rig/`. The source models they read from `recursos/models/` are not included in the repo.
