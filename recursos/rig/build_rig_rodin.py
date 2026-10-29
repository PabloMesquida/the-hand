# Rig de la malla Rodin (mano_optimizado.blend) - reemplazado por build_rig.py (mano_02)
import bpy, bmesh, sys, json, numpy as np
from mathutils import Vector
import os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(HERE)
from contours import loops

OUT_BLEND = r"C:/proyectos/mano/recursos/models/mano_rig.blend" # Rig viejo (malla Rodin)
SMOOTH_REPEAT = int(os.environ.get("SMOOTH_REPEAT", 4)) # Pasadas de suavizado de pesos

# ---------- Mesh: soldar las costuras de UV (7 islas sueltas => 1 malla cerrada) ----------
if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
mesh_obj = bpy.data.objects['model']
mesh_obj.name = 'hand_mesh'
me = mesh_obj.data
print("custom normals:", me.has_custom_normals)
bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
bm.to_mesh(me); me.update()
bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table(); bm.edges.index_update()
V = np.array([v.co[:] for v in bm.verts])
print("verts after weld", len(me.vertices))

def nearest_loop(n, d, ref, maxdist):
    ls = loops(bm, n, d)
    if not ls: return None
    best = min(ls, key=lambda p: np.linalg.norm(p.mean(0) - ref))
    return best if np.linalg.norm(best.mean(0) - ref) < maxdist else None

def centerline(start, z_end):
    pts = []; ref = np.array(start, float)
    for z in np.arange(start[2], z_end, 0.01):
        l = nearest_loop((0, 0, 1), z, np.array([ref[0], ref[1], z]), 0.04)
        if l is None or np.ptp(l[:, 0]) > 0.1: continue
        ref = l.mean(0); pts.append(ref)
    return np.array(pts)

def palm_depth(p, halfwidth=0.015):
    # centro del espesor de la palma (y) en la altura/columna de p
    l = max(loops(bm, (0, 0, 1), p[2]), key=len)
    near = l[np.abs(l[:, 0] - p[0]) < halfwidth]
    return near[:, 1].min(), near[:, 1].max()

def point_at(poly, s):
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    acc = np.concatenate([[0], np.cumsum(seg)])
    s *= acc[-1]
    i = min(np.searchsorted(acc, s) - 1, len(seg) - 1); i = max(i, 0)
    t = (s - acc[i]) / seg[i]
    return poly[i] + t * (poly[i + 1] - poly[i])

joints = {}
# Dedos: (separación del dedo, z máx para buscar la punta)
finger_starts = {
    'index':  (-0.055, 0.042, 1.575),
    'middle': ( 0.043, 0.054, 1.575),
    'ring':   ( 0.125, 0.041, 1.550),
    'pinky':  ( 0.192, 0.017, 1.500),
}
ratios = (0.46, 0.29, 0.25) # MCP->PIP, PIP->DIP, DIP->punta
for name, start in finger_starts.items():
    pts = centerline(start, 1.95)
    m = pts.mean(0); u = np.linalg.svd(pts - m)[2][0]; u = u if u[2] > 0 else -u
    mask = np.linalg.norm(V[:, :2] - pts[-1][:2], axis=1) < 0.05
    tip_vertex = V[mask][np.argmax(V[mask] @ u)]
    tip = pts[-1] + u * np.dot(tip_vertex - pts[-1], u) - u * 0.004
    visible = np.dot(tip - pts[0], u)
    mcp = pts[0] - u * visible * 0.3
    mcp[1] = pts[0][1] # mismo espesor que la base del dedo (dentro de la palma)
    poly = np.vstack([mcp, pts[(pts[:, 2] < tip[2] - 0.01)], tip])
    pip = point_at(poly, ratios[0]); dip = point_at(poly, ratios[0] + ratios[1])
    joints[name] = [mcp, pip, dip, tip]

# Pulgar (eje inclinado)
thumb_tip_vertex = np.array([-0.263, -0.074, 1.563])
thumb_base = np.array([-0.172, -0.069, 1.425])
u = (thumb_tip_vertex - thumb_base) / np.linalg.norm(thumb_tip_vertex - thumb_base)
tpts = []
for t in np.arange(0.0, np.linalg.norm(thumb_tip_vertex - thumb_base), 0.01):
    p = thumb_base + u * t
    l = nearest_loop(u, np.dot(p, u), p, 0.05)
    if l is not None: tpts.append(l.mean(0))
tpts = np.array(tpts)
tu = tpts[-1] - tpts[0]; tu /= np.linalg.norm(tu)
thumb_tip = tpts[-1] + tu * np.dot(thumb_tip_vertex - tpts[-1], tu) - tu * 0.004
thumb_length = 0.26  # MCP -> punta (proporción de mano real)
thumb_mcp = thumb_tip - tu * thumb_length
thumb_mcp[1] = -0.055
thumb_cmc = np.array([-0.050, -0.035, 1.175])
thumb_poly = np.vstack([thumb_mcp, tpts[:-1], thumb_tip])
thumb_ip = point_at(thumb_poly, 0.53)
joints['thumb'] = [thumb_cmc, thumb_mcp, thumb_ip, thumb_tip]

wrist = np.array([0.037, 0.0, 1.085])
elbow = np.array([0.030, 0.0, 0.03])
for k, v in joints.items(): print("JOINTS", k, [np.round(p, 3).tolist() for p in v])
json.dump({k: [p.tolist() for p in v] for k, v in joints.items()} | {'wrist': wrist.tolist(), 'elbow': elbow.tolist()},
          open(os.path.join(HERE, "joints.json"), "w"))

# ---------- Armature ----------
arm_data = bpy.data.armatures.new('rig')
rig = bpy.data.objects.new('rig', arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
palm = Vector((0, -1, 0)) # la palma mira a -Y

def add(name, head, tail, parent=None, roll_to=palm, connect=False):
    b = eb.new(name)
    b.head = Vector(head); b.tail = Vector(tail)
    b.align_roll(roll_to) # Z local hacia la palma => rotar +X cierra el dedo
    if parent: b.parent = parent; b.use_connect = connect
    return b

forearm = add('forearm', elbow, wrist)
hand = add('hand', wrist, joints['middle'][0], forearm, connect=True)
for name in ['thumb', 'index', 'middle', 'ring', 'pinky']:
    j = joints[name]
    roll = Vector((0.6, -1, 0)) if name == 'thumb' else palm
    parent = hand
    for i in range(3):
        parent = add(f'{name}_{i + 1:02d}', j[i], j[i + 1], parent, roll, connect=(i > 0))
bpy.ops.object.mode_set(mode='OBJECT')

# ---------- Skin (pesos automáticos / bone heat) ----------
bpy.ops.object.select_all(action='DESELECT')
mesh_obj.select_set(True); rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
unweighted = sum(1 for v in me.vertices if not any(g.weight > 0 for g in v.groups))
print("vertex groups", len(mesh_obj.vertex_groups), "unweighted verts", unweighted)

# Nudillos: los pesos automáticos hacen que el primer hueso de cada dedo arrastre media palma
# (el meñique llegaba casi a la muñeca). Por debajo del nudillo el peso pasa al hueso "hand".
def get_weight(group, index):
    try:
        return group.weight(index)
    except RuntimeError:
        return 0.0

def smoothstep(edge0, edge1, x):
    k = min(max((x - edge0) / (edge1 - edge0), 0.0), 1.0)
    return k * k * (3 - 2 * k)

hand_group = mesh_obj.vertex_groups['hand']
falloff = 0.035
for name in ['thumb', 'index', 'middle', 'ring', 'pinky']:
    group = mesh_obj.vertex_groups[f'{name}_01']
    head = Vector(joints[name][0].tolist())
    direction = (Vector(joints[name][1].tolist()) - head).normalized()
    for v in me.vertices:
        try:
            weight = group.weight(v.index)
        except RuntimeError:
            continue
        t = (v.co - head).dot(direction)
        if t >= 0:
            continue
        k = max(0.0, 1 + t / falloff)
        k = k * k * (3 - 2 * k)
        group.add([v.index], weight * k, 'REPLACE')
        hand_group.add([v.index], weight * (1 - k), 'ADD')

# Muñeca: los pesos automáticos pasan de antebrazo a mano en una sola línea => la muñeca se quiebra al doblar.
# Se reparte (solo la parte de hand + forearm) con una transición gradual a lo largo del eje de la mano.
forearm_group = mesh_obj.vertex_groups['forearm']
wrist_point = Vector(wrist.tolist())
hand_axis = (Vector(joints['middle'][0].tolist()) - wrist_point).normalized()
wrist_blend = 0.08
for v in me.vertices:
    t = (v.co - wrist_point).dot(hand_axis)
    if abs(t) > wrist_blend:
        continue
    total = get_weight(hand_group, v.index) + get_weight(forearm_group, v.index)
    if total == 0:
        continue
    s = smoothstep(- wrist_blend, wrist_blend, t)
    hand_group.add([v.index], total * s, 'REPLACE')
    forearm_group.add([v.index], total * (1 - s), 'REPLACE')

# Limpieza: suavizar (los pesos automáticos dejan cortes bruscos en los nudillos => pliegues al doblar),
# máximo 4 influencias por vértice (glTF) y normalizar
bpy.context.view_layer.objects.active = mesh_obj
bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=SMOOTH_REPEAT, expand=0)
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
bpy.ops.object.mode_set(mode='OBJECT')

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
print("SAVED", OUT_BLEND)
