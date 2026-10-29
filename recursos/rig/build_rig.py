# Rig de las manos de Human Base Meshes (Blender Studio, CC0)
# - mano_02: mano + antebrazo del cuerpo femenino realista (~14k quads)
# - mano_03: mano + antebrazo del cuerpo masculino realista (basado en escaneos, ~60k quads)
# - mano_03_sub_2: mano_03 simplificada (~15k vértices, viene en .glb: no hace falta abrir un .blend)
# Uso (desde C:\proyectos\mano), MODEL = mano_02 | mano_03 | mano_03_sub_2 (por defecto mano_03):
#   MODEL=mano_03 blender -b recursos/models/mano_03.blend --python recursos/rig/build_rig.py
#   MODEL=mano_03_sub_2 blender -b --python recursos/rig/build_rig.py
#   blender -b recursos/models/mano_03_sub_2_rig.blend --python recursos/rig/export.py
import bpy, bmesh, sys, json, os, numpy as np
from mathutils import Vector
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(HERE)
from contours import loops
from prep_mano_02 import prep

MODEL = os.environ.get("MODEL", "mano_03")
OUT_BLEND = rf"C:/proyectos/mano/recursos/models/{MODEL}_rig.blend"
SMOOTH_REPEAT = None # Pasadas de suavizado de pesos (por modelo: más vértices => más pasadas)
SUBDIVISION = 0 # Subdivision Surface después del armature (0 = no; las mallas ya son densas)

# Medidas de cada modelo (después de prep, con cortes en z: ver BITACORA)
# fingers: primer corte donde el dedo ya está separado
# thumb: separación y vértice de la punta
CONFIGS = {
    'mano_02': {
        'fingers': { 'index': (- 0.074, 0.014, 1.12), 'middle': (0.030, 0.018, 1.14), 'ring': (0.126, 0.003, 1.14), 'pinky': (0.239, - 0.032, 1.12) },
        'thumb_base': (- 0.174, - 0.077, 0.92), 'thumb_tip': (- 0.283, - 0.092, 1.021), 'thumb_length': 0.21,
        'wrist': (0.125, 0.0, 0.64), 'elbow': (0.15, 0.017, 0.03), 'top': 1.45, 'smooth': 2
    },
    'mano_03': {
        'fingers': { 'index': (- 0.129, - 0.015, 1.22), 'middle': (- 0.022, - 0.002, 1.24), 'ring': (0.062, - 0.011, 1.24), 'pinky': (0.177, - 0.044, 1.24) },
        'thumb_base': (- 0.216, - 0.129, 1.04), 'thumb_tip': (- 0.323, - 0.155, 1.123), 'thumb_length': 0.21,
        'wrist': (0.073, - 0.015, 0.80), 'elbow': (0.12, 0.025, 0.03), 'top': 1.56, 'smooth': 8
    }
}
# mano_03 simplificada: misma forma y medidas, ~4 veces menos vértices => menos pasadas de suavizado
CONFIGS['mano_03_sub_2'] = { **CONFIGS['mano_03'], 'smooth': 3 }
config = CONFIGS[MODEL]
SMOOTH_REPEAT = int(os.environ.get("SMOOTH_REPEAT", config["smooth"]))

# ---------- Mesh ----------
mesh_obj = prep(MODEL)
me = mesh_obj.data
bm = bmesh.new(); bm.from_mesh(me)
bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table(); bm.edges.index_update()
V = np.array([v.co[:] for v in bm.verts])
print("verts", len(me.vertices))

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

def point_at(poly, s):
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    acc = np.concatenate([[0], np.cumsum(seg)])
    s *= acc[-1]
    i = min(np.searchsorted(acc, s) - 1, len(seg) - 1); i = max(i, 0)
    t = (s - acc[i]) / seg[i]
    return poly[i] + t * (poly[i + 1] - poly[i])

# ---------- Articulaciones ----------
joints = {}
# Dedos: primer corte (z) donde el dedo ya está separado
ratios = (0.46, 0.29, 0.25) # MCP->PIP, PIP->DIP, DIP->punta (proporciones reales)
for name, start in config['fingers'].items():
    pts = centerline(start, config['top'])
    m = pts.mean(0); u = np.linalg.svd(pts - m)[2][0]; u = u if u[2] > 0 else - u
    mask = np.linalg.norm(V[:, :2] - pts[-1][:2], axis=1) < 0.05
    tip_vertex = V[mask][np.argmax(V[mask] @ u)]
    tip = pts[-1] + u * np.dot(tip_vertex - pts[-1], u) - u * 0.004
    visible = np.dot(tip - pts[0], u)
    mcp = pts[0] - u * visible * 0.3 # El nudillo está ~30% del largo visible por debajo de la separación
    mcp[1] = pts[0][1]
    poly = np.vstack([mcp, pts[(pts[:, 2] < tip[2] - 0.01)], tip])
    pip = point_at(poly, ratios[0]); dip = point_at(poly, ratios[0] + ratios[1])
    joints[name] = [mcp, pip, dip, tip]

# Pulgar (eje inclinado): centros de cortes perpendiculares desde la separación hasta la punta
thumb_base = np.array(config['thumb_base'])
thumb_tip_vertex = np.array(config['thumb_tip'])
u = (thumb_tip_vertex - thumb_base) / np.linalg.norm(thumb_tip_vertex - thumb_base)
tpts = []
for t in np.arange(0.0, np.linalg.norm(thumb_tip_vertex - thumb_base), 0.01):
    p = thumb_base + u * t
    l = nearest_loop(u, np.dot(p, u), p, 0.05)
    if l is not None and np.ptp(l, axis=0).max() < 0.12: tpts.append(l.mean(0))
tpts = np.array(tpts)
tu = tpts[-1] - tpts[0]; tu /= np.linalg.norm(tu)
thumb_tip = tpts[-1] + tu * np.dot(thumb_tip_vertex - tpts[-1], tu) - tu * 0.004
thumb_mcp = thumb_tip - tu * config['thumb_length'] # MCP -> punta (proporción de mano real)
thumb_mcp[1] = tpts[0][1]
wrist = np.array(config['wrist'])
elbow = np.array(config['elbow'])
thumb_cmc = wrist + np.array([- 0.09, - 0.04, 0.08])
thumb_poly = np.vstack([thumb_mcp, tpts[(tpts @ tu) > np.dot(thumb_mcp, tu)], thumb_tip])
thumb_ip = point_at(thumb_poly, 0.53)
joints['thumb'] = [thumb_cmc, thumb_mcp, thumb_ip, thumb_tip]

for k, v in joints.items(): print("JOINTS", k, [np.round(p, 3).tolist() for p in v])
json.dump({k: [p.tolist() for p in v] for k, v in joints.items()} | {'wrist': wrist.tolist(), 'elbow': elbow.tolist()},
          open(os.path.join(HERE, "joints.json"), "w"))

# ---------- Armature ----------
arm_data = bpy.data.armatures.new('rig')
rig = bpy.data.objects.new('rig', arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
palm = Vector((0, - 1, 0)) # la palma mira a -Y

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
    roll = Vector((0.6, - 1, 0)) if name == 'thumb' else palm
    parent = hand
    for i in range(3):
        parent = add(f'{name}_{i + 1:02d}', j[i], j[i + 1], parent, roll, connect=(i > 0))
bpy.ops.object.mode_set(mode='OBJECT')

# ---------- Skin (pesos automáticos / bone heat sobre la malla base) ----------
bpy.ops.object.select_all(action='DESELECT')
mesh_obj.select_set(True); rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
unweighted = sum(1 for v in me.vertices if not any(g.weight > 0 for g in v.groups))
print("vertex groups", len(mesh_obj.vertex_groups), "unweighted verts", unweighted)

def get_weight(group, index):
    try:
        return group.weight(index)
    except RuntimeError:
        return 0.0

def smoothstep(edge0, edge1, x):
    k = min(max((x - edge0) / (edge1 - edge0), 0.0), 1.0)
    return k * k * (3 - 2 * k)

# Nudillos: el primer hueso de cada dedo no debe arrastrar la palma (por debajo del nudillo el peso pasa a "hand")
hand_group = mesh_obj.vertex_groups['hand']
falloff = 0.035
for name in ['thumb', 'index', 'middle', 'ring', 'pinky']:
    group = mesh_obj.vertex_groups[f'{name}_01']
    head = Vector(joints[name][0].tolist())
    direction = (Vector(joints[name][1].tolist()) - head).normalized()
    for v in me.vertices:
        weight = get_weight(group, v.index)
        t = (v.co - head).dot(direction)
        if weight == 0 or t >= 0:
            continue
        k = smoothstep(- falloff, 0, t)
        group.add([v.index], weight * k, 'REPLACE')
        hand_group.add([v.index], weight * (1 - k), 'ADD')

# Muñeca: transición gradual antebrazo -> mano (solo la parte de hand + forearm)
# Se aplica a toda la malla (no solo cerca de la muñeca): fuera de la transición el bone heat deja restos
# ruidosos (1-5%) que en una malla densa se ven como escalones entre filas al doblar la muñeca
forearm_group = mesh_obj.vertex_groups['forearm']
wrist_point = Vector(wrist.tolist())
hand_axis = (Vector(joints['middle'][0].tolist()) - wrist_point).normalized()
wrist_blend = 0.08
for v in me.vertices:
    t = (v.co - wrist_point).dot(hand_axis)
    total = get_weight(hand_group, v.index) + get_weight(forearm_group, v.index)
    if total == 0:
        continue
    s = smoothstep(- wrist_blend, wrist_blend, t)
    hand_group.add([v.index], total * s, 'REPLACE')
    forearm_group.add([v.index], total * (1 - s), 'REPLACE')

# Limpieza: suavizar, máximo 4 influencias por vértice (glTF) y normalizar
bpy.context.view_layer.objects.active = mesh_obj
bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=SMOOTH_REPEAT, expand=0)
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Subdivisión después del armature: deforma la malla base y después suaviza (export.py la aplica)
if SUBDIVISION:
    subdivision = mesh_obj.modifiers.new('Subdivision', 'SUBSURF')
    subdivision.levels = SUBDIVISION
    subdivision.render_levels = SUBDIVISION

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
print("SAVED", OUT_BLEND)
