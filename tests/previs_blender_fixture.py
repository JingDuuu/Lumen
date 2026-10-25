"""Create a real animated, hierarchical GLB for isolated bridge acceptance."""
from pathlib import Path
import sys
import bpy
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
root = bpy.data.objects.new('RigRoot', None); bpy.context.collection.objects.link(root)
bpy.ops.mesh.primitive_cube_add(size=2, location=(2, 0, 1)); cube=bpy.context.object; cube.name='AnimatedCube'; cube.parent=root
material=bpy.data.materials.new('RedPBR'); material.diffuse_color=(0.8,0.1,0.05,1); material.use_nodes=True
material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(0.8,0.1,0.05,1); cube.data.materials.append(material)
image=bpy.data.images.new('FixtureTexture',width=2,height=2)
image.pixels=[0.8,0.1,0.05,1,0.2,0.4,0.8,1,0.2,0.4,0.8,1,0.8,0.1,0.05,1]; image.pack()
texture=material.node_tree.nodes.new('ShaderNodeTexImage'); texture.image=image
material.node_tree.links.new(texture.outputs['Color'],material.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
cube.location=(2,0,1); cube.keyframe_insert('location',frame=1); cube.location=(4,0,2); cube.keyframe_insert('location',frame=24)
cube.shape_key_add(name='Basis'); key=cube.shape_key_add(name='Stretch')
for vertex in key.data: vertex.co.z *= 1.4
key.value=0; key.keyframe_insert('value',frame=1); key.value=1; key.keyframe_insert('value',frame=24)
bpy.ops.object.camera_add(location=(6,-8,6)); bpy.context.object.name='Camera'; bpy.context.scene.camera=bpy.context.object
bpy.context.scene.frame_start=1; bpy.context.scene.frame_end=24; bpy.context.scene.render.fps=24; bpy.context.scene.frame_set(1)
output=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',export_cameras=True,export_animations=True,export_animation_mode='SCENE',export_force_sampling=True,export_frame_range=True,export_morph=True,export_morph_animation=True)
