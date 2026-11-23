extends Node
## --climate-movie: the Climate Vision demo film. Run with Godot's movie maker, e.g.
##   godot --path . --write-movie /tmp/cvmovie/f.png --fixed-fps 30 --resolution 1280x720 -- --climate-movie
## Real device commands go through the web app (AC, purifier), the simulation follows them, and captions explain
## each stage. Game time is fixed per frame, so the film plays at the right speed however slow the machine is.

var main: Node
var _cap: PanelContainer
var _cap_title: Label
var _cap_sub: Label
var _title: Control
var _orbit := 0.0          # radians a second of slow camera orbit


func _ready() -> void:
	main = get_parent()
	_build_captions()
	_run.call_deferred()


func _process(delta: float) -> void:
	if _orbit != 0.0 and main.rig and not (main.rig._tw and main.rig._tw.is_running()):
		main.rig.yaw += _orbit * delta
		main.rig._apply()


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func cmd(id: String, command: String, args: Dictionary) -> void:
	var h := HTTPRequest.new()
	add_child(h)
	h.request("%s/api/devices/%s/commands" % [Store.platform_url, id], ["Content-Type: application/json"], HTTPClient.METHOD_POST, JSON.stringify({"command": command, "args": args, "by": "climate-demo"}))
	await h.request_completed
	h.queue_free()
	Store._poll()


## Wait (game time) until the renderer sees the device change, so the picture and the caption agree.
func _until(f: Callable, limit := 4.0) -> void:
	var t := 0.0
	while t < limit and not f.call():
		await _wait(0.1)
		t += 0.1
		if int(t * 10) % 10 == 0:
			Store._poll()


# ---------------- captions ----------------

func _build_captions() -> void:
	var cl := CanvasLayer.new()
	cl.layer = 20
	add_child(cl)
	# lower third
	_cap = PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.04, 0.06, 0.1, 0.8)
	sb.set_corner_radius_all(12)
	sb.border_width_left = 5
	sb.border_color = Color(0.16, 0.48, 1.0)
	sb.content_margin_left = 22
	sb.content_margin_right = 22
	sb.content_margin_top = 12
	sb.content_margin_bottom = 12
	_cap.add_theme_stylebox_override("panel", sb)
	_cap.anchor_left = 0.5
	_cap.anchor_right = 0.5
	_cap.anchor_top = 1.0
	_cap.anchor_bottom = 1.0
	_cap.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_cap.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_cap.offset_bottom = -34
	_cap.modulate.a = 0.0
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 2)
	_cap.add_child(v)
	_cap_title = Label.new()
	_cap_title.add_theme_font_size_override("font_size", 26)
	_cap_title.add_theme_color_override("font_color", Color.WHITE)
	_cap_sub = Label.new()
	_cap_sub.add_theme_font_size_override("font_size", 17)
	_cap_sub.add_theme_color_override("font_color", Color(0.78, 0.84, 0.93))
	v.add_child(_cap_title)
	v.add_child(_cap_sub)
	cl.add_child(_cap)
	# title card
	_title = ColorRect.new()
	(_title as ColorRect).color = Color(0.03, 0.05, 0.09, 0.92)
	_title.set_anchors_preset(Control.PRESET_FULL_RECT)
	var c := VBoxContainer.new()
	c.set_anchors_preset(Control.PRESET_CENTER)
	c.grow_horizontal = Control.GROW_DIRECTION_BOTH
	c.grow_vertical = Control.GROW_DIRECTION_BOTH
	c.alignment = BoxContainer.ALIGNMENT_CENTER
	c.add_theme_constant_override("separation", 10)
	for t in [["SAMSUNG RESEARCH · 3D RENDERING POC", 18, Color(0.45, 0.65, 1.0)], ["AI-Powered 3D Climate Vision", 54, Color.WHITE],
			["Real-time airflow, heat & air-quality rendering of a live SmartThings room", 21, Color(0.75, 0.81, 0.9)]]:
		var l := Label.new()
		l.text = t[0]
		l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		l.add_theme_font_size_override("font_size", t[1])
		l.add_theme_color_override("font_color", t[2])
		c.add_child(l)
	_title.add_child(c)
	cl.add_child(_title)


func caption(title: String, sub: String) -> void:
	var tw := create_tween()
	if _cap.modulate.a > 0.0:
		tw.tween_property(_cap, "modulate:a", 0.0, 0.25)
	tw.tween_callback(func():
		_cap_title.text = title
		_cap_sub.text = sub)
	tw.tween_property(_cap, "modulate:a", 1.0, 0.35)


func _fade_title(on: bool, secs := 0.8) -> void:
	await create_tween().tween_property(_title, "modulate:a", 1.0 if on else 0.0, secs).finished


# ---------------- the film ----------------

func _run() -> void:
	for i in 400:
		if main.world != null and not Store.devices.is_empty() and not Store.live.is_empty():
			break
		await _wait(0.25)
	# quiet the map's own overlays for the film
	if main.hud:
		main.hud.get_parent().visible = false
	await cmd("AC-01", "power", {"on": false})
	await cmd("AP-01", "power", {"on": false})
	await _until(func(): return not bool(Store.live.get("AC-01", {}).get("on", true)))
	await _wait(1.0)
	# 0 - 4 s: title over the floor
	await _wait(3.0)
	_fade_title(false, 1.0)
	caption("A live SmartThings room, inside the 3D map", "Samsung R&D 4th floor · SmartThings Experience Zone · real AC, air purifier and sensors")
	await _wait(3.5)
	# hot room
	Bridge.handle({"type": "climate", "on": true, "hud": true, "reset": true, "windfree": false, "people": 2, "speed": 1.0, "heat": true, "airflow": true, "dust": true})
	await _wait(1.2)
	caption("Climate Vision: the air itself, rendered", "A hot afternoon, AC off · the ray-marched volume shows 29-30 °C everywhere (orange = too warm)")
	_orbit = 0.05
	await _wait(5.5)
	# AC on
	await cmd("AC-01", "power", {"on": true})
	await cmd("AC-01", "setTemperature", {"celsius": 24})
	await _until(func(): return main.climate.ac_on())
	caption("Turning the real AC on · set to 24 °C", "Command sent to the device · four louvre jets appear, coloured by the temperature they carry")
	await _wait(6.0)
	caption("Watch the cool air push the heat out", "1,600 airflow streaks follow the simulated flow · probes at the sofa, desk and window update live")
	await _wait(8.0)
	# WindFree
	caption("WindFree mode: cooling without draught", "Air seeps through micro-holes · a gentle blue fall under the panel instead of jets")
	Bridge.handle({"type": "climate", "windfree": true})
	await _wait(6.5)
	Bridge.handle({"type": "climate", "windfree": false})
	# smoke
	Bridge.handle({"type": "climate", "speed": 2.0})
	caption("What if… smoke near the sofa?", "The dust layer: PM2.5 drawn as a haze that drifts with the airflow")
	Bridge.handle({"type": "climate", "smoke": true})
	await _wait(7.0)
	# purifier
	await cmd("AP-01", "power", {"on": true})
	await cmd("AP-01", "setFan", {"level": 4})
	await _until(func(): return main.climate.purifier_on())
	caption("The real air purifier switches on · fan 4", "Its intake pulls the haze in · PM2.5 falls while the room settles into the comfort band")
	await _wait(8.0)
	# eye level
	_orbit = 0.0
	var c: Vector3 = main.climate.lo + main.climate.size / 2
	main.rig.fly_to(Vector3(c.x, 1.05, c.z - 0.5), 3.4, deg_to_rad(-9.0), deg_to_rad(15.0), 2.2)
	caption("Step inside, at eye level", "Same volume from within the room: the camera is inside the air it is drawing")
	await _wait(3.0)
	_orbit = -0.09
	await _wait(6.0)
	# back out and end
	_orbit = 0.0
	main.rig.fly_to(Vector3(c.x, 0.6, c.z), 12.0, deg_to_rad(-42.0), deg_to_rad(28.0), 2.0)
	caption("Live device data in · physics-based air out · rendered in real time", "Godot 4 · GLSL volume ray-marching · GPU instancing · runs in the browser (WebGL 2)")
	await _wait(5.0)
	await _fade_title(true, 1.0)
	await _wait(2.0)
	get_tree().quit()
