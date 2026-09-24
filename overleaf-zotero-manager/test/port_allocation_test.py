"""Host port allocation for the Zotero proxies.

Run it from anywhere:
    python overleaf-zotero-manager/test/port_allocation_test.py

This suite exists because of a bug that shipped: the next port was picked by
looking only at the proxies already registered, so the eighth proxy was handed
8098 while a service on the host network was listening there. Docker refused
the bind and the container stayed in Created, exit 128. The manager runs in a
bridge network, so it cannot test the host's ports by opening a socket, and a
container on the host network publishes nothing for docker ps to report. Only
the bind Docker performs settles it, so the retry is the fix and this suite
pins it.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models.zotero import ZoteroProxyManager  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"[PASS] {name}")
    except AssertionError as e:
        failures += 1
        print(f"[FAIL] {name}")
        print(f"        {e}")


def manager():
    return ZoteroProxyManager('/nonexistent', 'example/image')


def test_first_port_when_nothing_taken():
    assert manager()._next_candidate_port(set()) == 8091


def test_skips_taken_ports():
    assert manager()._next_candidate_port({8091, 8092, 8093}) == 8094


def test_skips_a_hole_free_port():
    # 8092 is free, so it is the answer even though higher ports are in use.
    assert manager()._next_candidate_port({8091, 8093, 8094}) == 8092


def test_recognises_docker_port_conflicts():
    is_conflict = ZoteroProxyManager._is_port_conflict
    assert is_conflict(
        'failed to bind host port 0.0.0.0:8098/tcp: address already in use'
    ), 'the exact message that shipped must be recognised'
    assert is_conflict('Bind for 0.0.0.0:8098 failed: port is already allocated')
    assert not is_conflict('no such image: example/image'), (
        'an unrelated failure must not be retried on another port'
    )


def test_retries_past_an_invisible_listener():
    """A listener docker ps cannot see moves the proxy up one port."""
    mgr = manager()
    compose_writes = []
    refused = {8098}

    mgr._update_docker_compose_add = lambda username, port, entity_type: (
        compose_writes.append(port)
    )
    mgr._stop_container = lambda container_name: None

    def fake_up(username):
        port = compose_writes[-1]
        if port in refused:
            raise Exception(
                f'Docker compose failed: failed to bind host port '
                f'0.0.0.0:{port}/tcp: address already in use'
            )

    mgr._docker_compose_up = fake_up

    taken = {8091, 8092, 8093, 8094, 8095, 8096, 8097}
    port = mgr._start_on_free_port('newuser', 'user', taken)

    assert port == 8099, f'expected 8099, got {port}'
    assert compose_writes == [8098, 8099], (
        f'expected an attempt on 8098 then 8099, got {compose_writes}'
    )


def test_gives_up_instead_of_looping_forever():
    mgr = manager()
    mgr._update_docker_compose_add = lambda username, port, entity_type: None
    mgr._stop_container = lambda container_name: None

    def always_busy(username):
        raise Exception('failed to bind host port: address already in use')

    mgr._docker_compose_up = always_busy

    try:
        mgr._start_on_free_port('newuser', 'user', set())
    except Exception as e:
        assert 'No free host port' in str(e), f'unexpected error: {e}'
    else:
        raise AssertionError('a host with every port busy must raise')


def test_other_failures_are_not_retried():
    mgr = manager()
    attempts = []
    mgr._update_docker_compose_add = lambda username, port, entity_type: (
        attempts.append(port)
    )
    mgr._stop_container = lambda container_name: None

    def broken(username):
        raise Exception('Docker compose failed: no such image')

    mgr._docker_compose_up = broken

    try:
        mgr._start_on_free_port('newuser', 'user', set())
    except Exception as e:
        assert 'no such image' in str(e), f'unexpected error: {e}'
    assert attempts == [8091], f'expected a single attempt, got {attempts}'


for name, fn in sorted(
    (n, f) for n, f in globals().items() if n.startswith('test_')
):
    test(name, fn)

if failures:
    print(f"\n{failures} failing")
    sys.exit(1)
print("\nall green")
