# Renderiza una pose de Hand.js en Blender para revisarla (frente, costado, dorso, arriba)
# Uso: blender -b recursos/models/mano_rig.blend --python recursos/rig/pose_preview.py -- <pose.json> <carpeta salida> [prefijo] [vistas: palm,thumbside,back,pinkyside,top]
# pose.json: { "thumb": [nudillo, media, distal, apertura], "index": [...], ... } en grados, igual que `poses` en src/Hand.js
import bpy, sys, json, math
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
pose = json.load(open(args[0]))
out = args[1]
prefix = args[2] if len(args) > 2 else 'pose'

rig = bpy.data.objects['rig']
for name, values in pose.items():
    # Antebrazo: [inclinación x, torsión y, inclinación z]
    if name == 'forearm':
        pb = rig.pose.bones['forearm']
        pb.rotation_mode = 'ZYX'
        pb.rotation_euler = tuple(math.radians(v) for v in values)
        continue
    # Muñeca: [flexión (+ hacia la palma), desviación (+ hacia el pulgar)]
    if name == 'wrist':
        pb = rig.pose.bones['hand']
        pb.rotation_mode = 'ZYX'
        pb.rotation_euler = (math.radians(values[0]), 0, math.radians(values[1]))
        continue
    for i in range(3):
        pb = rig.pose.bones[f'{name}_0{i + 1}']
        # three.js Euler 'XYZ' (intrínseco) == Blender 'ZYX'
        pb.rotation_mode = 'ZYX'
        pb.rotation_euler = (math.radians(values[i]), 0, math.radians(values[3]) if i == 0 else 0)

scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'OBJECT'
scene.render.resolution_x = 600
scene.render.resolution_y = 600
bpy.data.objects['hand_mesh'].color = (0.85, 0.7, 0.6, 1)

cam_data = bpy.data.cameras.new('c'); cam_data.type = 'ORTHO'; cam_data.ortho_scale = float(__import__('os').environ.get('ORTHO', 0.62))
cam = bpy.data.objects.new('c', cam_data); scene.collection.objects.link(cam); scene.camera = cam
center = Vector(json.loads(__import__("os").environ.get("CENTER", "[0, 0, 1.55]")))
all_views = { 'palm': (0, -3, 0), 'thumbside': (-3, 0, 0), 'back': (0, 3, 0), 'pinkyside': (3, 0, 0), 'top': (0, -0.8, 3) }
views = {k: all_views[k] for k in (args[3].split(',') if len(args) > 3 else all_views)}
for view, offset in views.items():
    cam.location = center + Vector(offset)
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = f'{out}/{prefix}_{view}.png'
    bpy.ops.render.render(write_still=True)
