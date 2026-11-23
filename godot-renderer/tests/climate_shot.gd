extends Node
## --climate-shots=<dir>: plays the Climate Vision story with real device commands through the web app (AC off on a
## hot afternoon; AC on; WindFree; smoke and the purifier) and saves a picture at each stage, with the frame time.

var out := "/tmp/climate"
var _worst := 0.0
var _last := 0


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--climate-shots="):
			out = a.substr(16)
	_run.call_deferred()


func _process(_d: float) -> void:
	var now := Time.get_ticks_msec()
	if _last > 0 and get_parent().climate != null:
		_worst = maxf(_worst, now - _last)
	_last = now


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func cmd(id: String, command: String, args: Dictionary) -> void:
	var h := HTTPRequest.new()
	add_child(h)
	h.request("%s/api/devices/%s/commands" % [Store.platform_url, id], ["Content-Type: application/json"], HTTPClient.METHOD_POST, JSON.stringify({"command": command, "args": args, "by": "climate-demo"}))
	await h.request_completed
	h.queue_free()
	await _wait(2.5)   # the live readings follow


func _shot(n: String) -> void:
	await RenderingServer.frame_post_draw
	DirAccess.make_dir_recursive_absolute(out)
	get_viewport().get_texture().get_image().save_png("%s/%s.png" % [out, n])
	print("shot ", n, " worst frame so far ", int(_worst), " ms")


func _run() -> void:
	var main := get_parent()
	for i in 200:
		if main.world != null and not Store.devices.is_empty() and not Store.live.is_empty():
			break
		await _wait(0.25)
	await _wait(1.5)
	await cmd("AC-01", "power", {"on": false})
	await cmd("AP-01", "power", {"on": false})
	Bridge.handle({"type": "climate", "on": true, "hud": true, "reset": true, "windfree": false, "people": 2})
	await _wait(5.0)
	await _shot("1_hot_ac_off")
	await cmd("AC-01", "power", {"on": true})
	await cmd("AC-01", "setTemperature", {"celsius": 24})
	await _wait(3.0)
	await _shot("2_ac_on_jets")
	await _wait(20.0)
	await _shot("3_cooling")
	Bridge.handle({"type": "climate", "windfree": true})
	await _wait(6.0)
	await _shot("4_windfree")
	Bridge.handle({"type": "climate", "smoke": true, "windfree": false})
	await _wait(10.0)
	await _shot("5_smoke")
	await cmd("AP-01", "power", {"on": true})
	await cmd("AP-01", "setFan", {"level": 4})
	await _wait(18.0)
	await _shot("6_purifier")
	print("CLIMATE SHOTS done; worst frame ", int(_worst), " ms; climate script ", main.climate._prof_ms, " ms a frame ", main.climate.prof, " grid ", main.climate.nx, "x", main.climate.ny, "x", main.climate.nz)
	get_tree().quit()
