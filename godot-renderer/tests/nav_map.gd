extends Node
## --navmap=x0,z0,x1,z1: free (.) / blocked (#) cells of the walk grid in that box, and the furniture in it.
func _ready() -> void:
	_run.call_deferred()

func _run() -> void:
	var main := get_parent()
	var box := PackedFloat64Array()
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--navmap="):
			for v in a.get_slice("=", 1).split(","):
				box.append(float(v))
	for i in 240:
		if main.world != null and Store.rooms.size() > 5:
			break
		await get_tree().create_timer(0.25).timeout
	await get_tree().create_timer(2.0).timeout
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	var nav := WalkNav.new()
	nav.build(main.floor_builder.wall_pieces, main.floor_builder.lintels)
	var z := box[1]
	while z < box[3]:
		var line := "%6.2f " % z
		var x := box[0]
		while x < box[2]:
			line += "." if nav.is_free(Vector2(x, z)) else "#"
			x += 0.1
		print(line)
		z += 0.1
	for f in Store.furniture:
		var x := float(f.get("x", 0)); var zz := float(f.get("z", 0))
		if x > box[0] - 1 and x < box[2] + 1 and zz > box[1] - 1 and zz < box[3] + 1:
			print(f.kind, " ", snappedf(x, 0.01), ",", snappedf(zz, 0.01), " w ", snappedf(float(f.get("w", 0)), 0.01), " d ", snappedf(float(f.get("d", 0)), 0.01), " rot ", snappedf(float(f.get("rot", 0)), 0.01))
	for wp in main.floor_builder.wall_pieces:
		var a: Vector2 = wp[0]; var b: Vector2 = wp[1]
		if minf(a.x, b.x) < box[2] and maxf(a.x, b.x) > box[0] and minf(a.y, b.y) < box[3] and maxf(a.y, b.y) > box[1]:
			print("WALL ", a, " -> ", b)
	print("RADIUS ", WalkNav.RADIUS)
	get_tree().quit()
