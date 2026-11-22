extends Node
## --guest=<token> --guest-stress=<rounds>: repeats what a guest does in the 3D view (tour stops on every device,
## step-free on/off, restarting the walk) and reports the slowest frame and whether nodes keep piling up.
## Fails when a frame stalls over 250 ms once warmed up (outside the deliberate floor rebuild of a restart) or the scene keeps growing round after round.

var rounds := 4
var worst := 0.0
var worst_at := ""
var warm := 0.0   # slowest frame after the first round (the first draws of each effect compile once)
var _last := 0
var _phase := "start"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--guest-stress="):
			rounds = int(a.substr(15))
	_run.call_deferred()


func _process(_d: float) -> void:
	var now := Time.get_ticks_msec()
	if _last > 0 and now - _last > worst and _phase != "start" and not _phase.ends_with("restart"):  # a restart rebuilds the floor on purpose
		worst = now - _last
		worst_at = _phase
	if _last > 0 and not _phase.begins_with("round 0") and not _phase.ends_with("restart") and _phase != "start":
		warm = maxf(warm, now - _last)
	_last = now


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.walker != null and not Store.devices.is_empty():
			break
		await _wait(0.25)
	await _wait(3.0)
	var nodes: Array[int] = []
	for r in rounds:
		_phase = "round %d tour" % r
		for d in Store.devices:
			_phase = "round %d tour %s" % [r, d.id]
			var t0 := Time.get_ticks_msec()
			Bridge.handle({"type": "walk", "action": "show", "id": d.id})
			if Time.get_ticks_msec() - t0 > 50:
				print("  show %s took %d ms" % [d.id, Time.get_ticks_msec() - t0])
			await _wait(1.2)
		_phase = "round %d step-free restart" % r   # a guest still on the way is walked again from the entrance
		Bridge.handle({"type": "walk", "action": "stepFree", "on": r % 2 == 0})
		await _wait(1.5)
		_phase = "round %d restart" % r
		Bridge.handle({"type": "walk", "action": "restart", "from": ""})
		await _wait(4.0)
		_phase = "round %d settle" % r
		await _wait(1.0)
		nodes.append(main.get_tree().get_node_count())
		print("round %d: nodes %d, slowest frame so far %d ms (%s)" % [r, nodes[-1], worst, worst_at])
	var grows := nodes.size() >= 3 and nodes[-1] > nodes[1] + 200
	var bad := warm > 250 or grows
	print("STRESS %s  slowest after warm-up %d ms; first round %d ms at %s; nodes %s" % ["FAIL" if bad else "OK", warm, worst, worst_at, str(nodes)])
	get_tree().quit(1 if bad else 0)
