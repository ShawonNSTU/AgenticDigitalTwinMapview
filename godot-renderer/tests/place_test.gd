extends Node
## --place=<dir>: drives drag and drop like the host page does (dragStart / dragMove / dragEnd), posts each
## drop to the platform like the page, waits for the device to arrive, and saves screenshots.
## Needs the platform running (PLATFORM_URL or http://localhost:3000).

var out := "/tmp/place"
var main: Node
var _http: HTTPRequest
var _posted := 0
var log: Array = []


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--place="):
			out = a.substr(8)
	DirAccess.make_dir_recursive_absolute(out)
	main = get_parent()
	_http = HTTPRequest.new()
	add_child(_http)
	Bus.device_dropped.connect(_post)
	_run.call_deferred()


func _post(info: Dictionary) -> void:
	var body := {"type": info.deviceType, "x": info.x, "z": info.z, "y": info.y, "rotationY": info.rotationY, "room": info.room}
	log.append("drop %s in %s at (%.2f, %.2f) rot %.2f" % [info.deviceType, info.room, info.x, info.z, info.rotationY])
	_http.request(Store.platform_url + "/api/devices", ["Content-Type: application/json"], HTTPClient.METHOD_POST, JSON.stringify(body))
	await _http.request_completed
	_posted += 1
	Bridge.handle({"type": "refreshDevices"})


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _shot(n: String) -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("%s/%s.png" % [out, n])


## Screen position (0..1) of a floor point.
func _uv(p: Vector3) -> Vector2:
	var cam: Camera3D = main.rig.cam
	return cam.unproject_position(p) / get_viewport().get_visible_rect().size


func _drag(type: String, at: Vector3) -> void:
	Bridge.handle({"type": "dragStart", "deviceType": type})
	var from := at + Vector3(-3, 0, 2)
	for i in 8:
		var uv := _uv(from.lerp(at, i / 7.0))
		Bridge.handle({"type": "dragMove", "u": uv.x, "v": uv.y})
		await get_tree().process_frame
	var uv2 := _uv(at)
	Bridge.handle({"type": "dragEnd", "u": uv2.x, "v": uv2.y, "drop": true})


func _room_centre(key: String) -> Vector3:
	var r: Dictionary = Store.room(key)
	var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
	return Vector3(c.x, 0, c.y)


func _run() -> void:
	while main.world == null:
		await _wait(0.5)
	await _wait(4.0)
	# clean floor first
	for d in Store.devices.duplicate():
		_http.request(Store.platform_url + "/api/devices/" + d.id, [], HTTPClient.METHOD_DELETE)
		await _http.request_completed
	Bridge.handle({"type": "refreshDevices"})
	await _wait(2.0)
	await _shot("0_empty")
	# look at Zone B and drop an AC: the ghost should snap to a wall
	var gym := _room_centre("training-room-403-sajek")
	main.rig.fly_to(gym, 14.0, deg_to_rad(-55.0), 0.0, 0.01)
	await _wait(0.5)
	Bridge.handle({"type": "dragStart", "deviceType": "ac"})
	for i in 10:
		var uv := _uv(gym + Vector3(-2.0 + i * 0.25, 0, 1.5 + i * 0.1))
		Bridge.handle({"type": "dragMove", "u": uv.x, "v": uv.y})
		await get_tree().process_frame
	await _wait(0.2)
	await _shot("1_dragging_ac")
	var uv3 := _uv(gym + Vector3(0.5, 0, 2.5))
	Bridge.handle({"type": "dragEnd", "u": uv3.x, "v": uv3.y, "drop": true})
	await _wait(2.5)
	await _shot("2_ac_dropped")
	# a mixed set across the floor
	var plan := [["light", "training-room-403-sajek", Vector3(-2, 0, 0)], ["camera", "training-room-403-sajek", Vector3(-4, 0, -3)],
		["tv", "smartthings-experience-zone", Vector3(1, 0, 0)], ["speaker", "smartthings-experience-zone", Vector3(-1, 0, 1)],
		["fridge", "maternity-room", Vector3(0, 0, -1)], ["purifier", "medical-room", Vector3(1, 0, 1)],
		["lock", "medical-room", Vector3(1.5, 0, 2.2)], ["motion", "zone-d-workspace", Vector3(3, 0, -2)],
		["ac", "zone-d-workspace", Vector3(0, 0, -3)], ["ac", "gym-room", Vector3(-3, 0, 0)], ["ac", "cafeteria-208-seats", Vector3(0, 0, -6)],
		["temphum", "male-toilet", Vector3(0, 0, 0)], ["leak", "male-toilet", Vector3(-0.5, 0, 0.5)], ["washer", "utility-room", Vector3(0, 0, 0)],
		["plug", "hub-room", Vector3(0, 0, 0)], ["odu", "ac-outdoor", Vector3(0, 0, 0)], ["blinds", "male-pray-room", Vector3(0, 0, 2)],
		["vacuum", "female-pray-room", Vector3(0, 0, 0)], ["oven", "cafeteria-6-seats", Vector3(1, 0, 0)], ["doorbell", "store-room", Vector3(0, 0, -1)]]
	main.rig.reset(0.01)
	await _wait(0.6)
	for item in plan:
		var at: Vector3 = _room_centre(item[1]) + item[2]
		var n := _posted
		await _drag(item[0], at)
		print("placed ", item[0], " fps ", Engine.get_frames_per_second(), " t ", Time.get_ticks_msec() / 1000.0)
		var tries := 0
		while _posted == n and tries < 20:
			await _wait(0.1)
			tries += 1
		await _wait(0.3)
	await _wait(2.5)
	await _shot("3_floor_with_devices")
	log.append("devices on the floor: %d" % Store.devices.size())
	# aiming at a wall between two rooms picks the room on the camera's side, not the one behind the wall
	main.rig.reset(0.01)
	await _wait(0.5)
	var cam: Camera3D = main.rig.cam
	var good := 0
	var tried := 0
	for sg in PlanGeo.wall_segments(Store.rooms):
		if tried >= 16:
			break
		var a: Vector2 = sg[0]
		var b: Vector2 = sg[1]
		if a.distance_to(b) < 2.0:
			continue
		var mid := (a + b) * 0.5
		var e := (b - a).normalized()
		var nrm := Vector2(-e.y, e.x)
		var r1: Dictionary = Store.room_at(mid + nrm * 0.4)
		var r2: Dictionary = Store.room_at(mid - nrm * 0.4)
		if r1.is_empty() or r2.is_empty() or r1.key == r2.key:
			continue
		var cam2 := Vector2(cam.global_position.x, cam.global_position.z)
		var near_r: Dictionary = r1 if (cam2 - mid).dot(nrm) > 0.0 else r2
		var wp := Vector3(mid.x, Store.wall_height * 0.7, mid.y)
		if cam.is_position_behind(wp):
			continue
		var p = Placer.pointer_floor(cam, cam.unproject_position(wp))
		tried += 1
		var got: String = Store.room_at(p).get("key", "out") if p != null else "none"
		if got == near_r.key:
			good += 1
		else:
			log.append("wall aim: %s|%s wall, camera side %s, got %s" % [r1.key, r2.key, near_r.key, got])
	log.append("wall aim: %d/%d picked the room on the camera's side" % [good, tried])
	# move one: the first AC goes to the other side of its room
	var first: Dictionary = Store.devices[0]
	Bridge.handle({"type": "startMove", "id": first.id})
	await _wait(0.3)
	log.append("move started: %s" % main.placer.active())
	main.placer.cancel()
	# open the outdoor unit's twin
	for d in Store.devices:
		if d.type == "odu":
			Bridge.handle({"type": "openDevice", "id": d.id})
	await _wait(4.0)
	await _shot("4_odu_twin")
	var f := FileAccess.open(out + "/log.txt", FileAccess.WRITE)
	f.store_string("\n".join(log))
	print("PLACE TEST OK ", Store.devices.size())
	get_tree().quit()
