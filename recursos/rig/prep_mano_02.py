# Prepara la malla de un modelo de mano para riguear (lo usa build_rig.py)
# Modelos: mano + antebrazo recortados de los cuerpos realistas de "Human Base Meshes" (Blender Studio, CC0)
# - vienen a escala real (~0.36 m) con los dedos hacia +Z
# - se rotan (y si hace falta se espejan) para que la palma mire a -Y y el pulgar a -X
#   (misma convención que el rig y Hand.js)
# - se escalan x4 y la base del antebrazo queda en z = 0
# - se tapa la boca del corte del antebrazo (el bone heat funciona mejor con la malla cerrada)
import bpy, bmesh, math
from mathutils import Matrix

SCALE = 4

# rotation: grados en Z, mirror: espejar en X después de rotar
# glb: el modelo viene como .glb (se importa en una escena vacía y se sueldan los vértices duplicados de las costuras UV)
MODELS = {
    'mano_02': { 'rotation': - 90, 'mirror': False }, # cuerpo femenino (palma +X, pulgar -Y)
    'mano_03': { 'rotation': 90, 'mirror': True }, # cuerpo masculino (palma -X, pulgar -Y: la otra mano)
    'mano_03_sub_2': { 'rotation': 90, 'mirror': True, 'glb': r'C:/proyectos/mano/recursos/models/mano_03_sub_2.glb' } # mano_03 simplificada (~15k vértices)
}

def prep(model):
    config = MODELS[model]
    if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    if 'glb' in config:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=config['glb'])
    obj = [o for o in bpy.data.objects if o.type == 'MESH'][0]
    if 'glb' in config:
        bm = bmesh.new(); bm.from_mesh(obj.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.00001)
        bm.to_mesh(obj.data)
    obj.name = 'hand_mesh'
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj; obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    me = obj.data
    me.transform(Matrix.Rotation(math.radians(config['rotation']), 4, 'Z'))
    if config['mirror']:
        me.transform(Matrix.Diagonal((- 1, 1, 1, 1)))
        me.flip_normals() # el espejo invierte el sentido de las caras
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
    z_min = min(v.co.z for v in me.vertices)
    me.transform(Matrix.Translation((- (min(xs) + max(xs)) / 2, - (min(ys) + max(ys)) / 2, - z_min)))
    me.transform(Matrix.Scale(SCALE, 4))

    bm = bmesh.new(); bm.from_mesh(me)
    boundary = [e for e in bm.edges if e.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bm.to_mesh(me)
    for polygon in me.polygons:
        polygon.use_smooth = True
    me.update()
    return obj
