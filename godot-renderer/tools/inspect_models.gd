extends SceneTree
## Prints each furniture model's size and renders a lineup seen from +z (to check which way models face).
func _init() -> void:
	var dir := "res://assets/furniture/kenney/"
	var names: Array = []
	for f in DirAccess.get_files_at(dir):
		if f.ends_with(".glb"):
			names.append(f.get_basename())
	names.sort()
	var root := Node3D.new()
	get_root().add_child.call_deferred(root)
	var x := 0.0
	for n in names:
		var sc: PackedScene = load(dir + n + ".glb")
		var inst: Node3D = sc.instantiate()
		var box := AABB()
		var first := true
		var meshes := 0
		var surfaces := 0
		for m in inst.find_children("*", "MeshInstance3D", true, false):
			var mi := m as MeshInstance3D
			var t: Transform3D = Transform3D.IDENTITY
			var p: Node = mi
			while p != inst:
				t = (p as Node3D).transform * t
				p = p.get_parent()
			var bb := t * mi.mesh.get_aabb()
			box = bb if first else box.merge(bb)
			first = false
			meshes += 1
			surfaces += mi.mesh.get_surface_count()
		print("%-24s size %s  meshes %d surfaces %d" % [n, str(box.size.snapped(Vector3.ONE * 0.001)), meshes, surfaces])
		inst.position = Vector3(x - box.get_center().x, -box.position.y, 0)
		root.add_child(inst)
		x += box.size.x + 0.4
	var cam := Camera3D.new()
	root.add_child(cam)
	cam.position = Vector3(x / 2, 0.9, 9.0)
	cam.fov = 40
	cam.look_at_from_position(Vector3(x / 2, 2.5, 7.5), Vector3(x / 2, 0.3, 0))
	var sun := DirectionalLight3D.new()
	sun.rotation = Vector3(-0.8, 0.4, 0)
	root.add_child(sun)
	var we := WorldEnvironment.new()
	we.environment = Environment.new()
	we.environment.background_mode = Environment.BG_COLOR
	we.environment.background_color = Color(0.85, 0.87, 0.9)
	we.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	we.environment.ambient_light_color = Color(0.7, 0.7, 0.7)
	root.add_child(we)
	await process_frame
	await process_frame
	await process_frame
	get_root().get_texture().get_image().save_png("/tmp/lineup.png")
	quit()
