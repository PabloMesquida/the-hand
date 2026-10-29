import bmesh, numpy as np

def weld(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table(); bm.edges.index_update()
    return bm

def loops(bm, normal, d):
    n = np.array(normal, float); n /= np.linalg.norm(n)
    s = {v.index: np.dot(v.co, n) - d for v in bm.verts}
    pt = {}
    for e in bm.edges:
        a, b = s[e.verts[0].index], s[e.verts[1].index]
        if a * b < 0:
            t = a / (a - b)
            pt[e.index] = np.array(e.verts[0].co) + t * (np.array(e.verts[1].co) - np.array(e.verts[0].co))
    parent = {k: k for k in pt}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for f in bm.faces:
        ce = [e.index for e in f.edges if e.index in pt]
        for i in range(1, len(ce)):
            parent[find(ce[i])] = find(ce[0])
    groups = {}
    for k in pt: groups.setdefault(find(k), []).append(pt[k])
    return [np.array(g) for g in groups.values() if len(g) > 3]
