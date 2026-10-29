import bpy, math, sys
from mathutils import Vector
out = sys.argv[sys.argv.index('--')+1]; tag = sys.argv[sys.argv.index('--')+2]
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'; sh.color_type = 'OBJECT'
scene.render.resolution_x = 700; scene.render.resolution_y = 800
rig = bpy.data.objects['rig']; hand = bpy.data.objects['hand_mesh']
hand.color = (0.8, 0.8, 0.8, 1)
pose = tag == 'pose'
if pose:
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        n = pb.name
        if n.startswith(('index','middle','ring','pinky')):
            pb.rotation_euler.x = math.radians({'01':55,'02':80,'03':50}[n[-2:]])
        if n.startswith('thumb'):
            pb.rotation_euler.x = math.radians({'01':20,'02':30,'03':40}[n[-2:]])
        if n == 'hand': pb.rotation_euler.x = math.radians(-25)
else:
    sh.show_xray = True; sh.xray_alpha = 0.35
    mat = bpy.data.materials.new('m')
    for b in rig.data.bones:
        for p, col in [(b.head_local, (1,0.1,0.1,1)), (b.tail_local, (0.1,0.3,1,1))]:
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.009, location=rig.matrix_world @ p)
            bpy.context.object.color = col
        # stick
        h = rig.matrix_world @ b.head_local; t = rig.matrix_world @ b.tail_local
        bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=(t-h).length, location=(h+t)/2)
        c = bpy.context.object; c.rotation_mode='QUATERNION'; c.rotation_quaternion = (t-h).to_track_quat('Z','Y'); c.color=(1,0.8,0,1)
cam_data = bpy.data.cameras.new('c'); cam_data.type = 'ORTHO'; cam_data.ortho_scale = float(__import__('os').environ.get('ORTHO', 0.95))
cam = bpy.data.objects.new('c', cam_data); scene.collection.objects.link(cam); scene.camera = cam
center = Vector(__import__('json').loads(__import__('os').environ.get('CENTER', '[0, 0, 1.45]')))
for name, off in {'front': (0,-3,0), 'side': (-3,0,0)}.items():
    cam.location = center + Vector(off)
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath = f"{out}/{tag}_{name}.png"
    bpy.ops.render.render(write_still=True)
