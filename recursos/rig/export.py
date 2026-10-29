import bpy
bpy.ops.export_scene.gltf(
    filepath=r"C:/proyectos/mano/static/hand.glb",
    export_format='GLB',
    export_yup=True,
    export_skins=True,
    export_animations=False,
    export_image_format='WEBP',
    export_apply=True, # aplica la Subdivision (el armature se mantiene como skin)
    use_selection=False,
)
print("EXPORTED")
