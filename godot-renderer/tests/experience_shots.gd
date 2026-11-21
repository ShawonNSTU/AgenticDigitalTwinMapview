extends Node
## --xp-shots=<dir>: the hotel experience layers against a running platform: comfort field (thermal, air, score),
## energy flows and device pillars, beacons for attention and predicted failures, a technician's route to a device,
## arrival auras, the TV welcome, and the zone at each quality tier with its CPU-side cost. Platform running.

var out := "/tmp/xp"
const ROOM := "smartthings-experience-zone"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--xp-shots="):
			out = a.substr(11)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _shot(name: String) -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(out + "/" + name + ".png")
	print("shot ", name, "  draw_calls ", Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), "  process_ms %.2f" % (Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0))


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.world != null and Store.layout_version > 0 and not Store.experience.is_empty():
			break
		await _wait(0.25)
	await _wait(2.0)
	var r: Dictionary = Store.room(ROOM)
	if r.is_empty():
		print("XP SHOTS: no zone room")
		get_tree().quit(1)
		return
	var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
	var zone := Vector3(c.x, 0, c.y)
	print("experience keys ", Store.experience.keys(), " comfort rooms ", Store.experience.get("comfort", {}).keys())
	main.rig.reset(0.1)
	await _wait(1.5)
	await _shot("0_floor_ops")
	# comfort
	Bridge.handle({"type": "setLayer", "layer": "comfort", "on": true})
	main.rig.fly_to(zone, 9.0, deg_to_rad(-58.0), deg_to_rad(25.0), 0.1)
	await _wait(2.5)
	await _shot("1_comfort_thermal")
	Bridge.handle({"type": "setLayer", "layer": "comfort", "on": true, "metric": "air"})
	await _wait(1.5)
	await _shot("1b_comfort_air")
	Bridge.handle({"type": "setLayer", "layer": "comfort", "on": false, "metric": "thermal"})
	# energy
	Bridge.handle({"type": "setLayer", "layer": "energy", "on": true})
	main.rig.reset(0.1)
	await _wait(2.0)
	await _shot("2_energy_floor")
	main.rig.fly_to(zone, 9.0, deg_to_rad(-45.0), deg_to_rad(25.0), 0.1)
	await _wait(1.5)
	await _shot("3_energy_zone")
	Bridge.handle({"type": "setLayer", "layer": "energy", "on": false})
	# technician route to the zone's AC
	var ac := ""
	for d in Store.devices:
		if d.room == ROOM and d.type == "ac":
			ac = d.id
	if ac != "":
		Bridge.handle({"type": "dispatchRoute", "id": ac})
		await _wait(1.6)
		await _shot("4_tech_route")
		await _wait(5.0)
		await _shot("4b_tech_walking")
	# quality tiers, inside the zone
	Bridge.handle({"type": "walk", "action": "start", "room": ROOM})
	await _wait(10.0)
	if main.walker:
		main.walker.set_process(false)
	for t in ["lite", "balanced", "high"]:
		Bridge.handle({"type": "setQuality", "tier": t})
		await _wait(1.2)
		await _shot("5_quality_" + t)
	# the welcome on the TV
	Bridge.handle({"type": "welcome", "room": ROOM, "guest": "Ayesha Rahman", "state": "ready"})
	await _wait(1.0)
	await _shot("6_welcome")
	Bridge.handle({"type": "setLayer", "layer": "comfort", "on": true})
	await _wait(2.0)
	await _shot("7_walk_comfort")
	print("XP SHOTS DONE")
	get_tree().quit(0)
