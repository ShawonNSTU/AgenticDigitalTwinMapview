extends Node
## --lift-shots=<dir> with --guest=<token>: frames of a guest's arrival by lift (doors shut, opening, stepping out,
## doors closing, setting off).

var out := ""


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--lift-shots="):
			out = a.get_slice("=", 1)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _run() -> void:
	var main := get_parent()
	for i in 400:
		if main.walker != null and main.walker.lift_busy():
			break
		await get_tree().create_timer(0.05).timeout
	# by the arrival's own clock (software rendering is slower than real time)
	for at in [0.4, 1.7, 2.6, 3.6, 4.9, 6.6]:
		while main.walker.lift_busy() and float(main.walker._lift.t) < at:
			await get_tree().process_frame
		if not main.walker.lift_busy():
			for k in 30:
				await get_tree().process_frame
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png("%s/lift_%.1f.png" % [out, at])
		print("shot ", at)
	get_tree().quit()
