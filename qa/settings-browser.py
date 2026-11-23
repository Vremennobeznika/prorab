"""Settings input/paste, stable polling, local persistence and compact layout regression."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
process = subprocess.Popen(['node', 'qa/settings-fixture.mjs'], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    fixture = json.loads(process.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1000, 'height': 640}, permissions=['clipboard-read', 'clipboard-write'])
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(fixture['base'] + '/?token=' + fixture['token'])
        page.locator('[data-tab=models]').click()
        field = page.locator('#provider-key-zai')
        field.fill('dummy-before-poll')
        page.evaluate("() => window.__keyField=document.getElementById('provider-key-zai')")
        page.wait_for_timeout(5200)
        assert field.input_value() == 'dummy-before-poll'
        assert page.evaluate("() => window.__keyField === document.getElementById('provider-key-zai')")
        field.select_text()
        page.evaluate("() => navigator.clipboard.writeText('dummy-pasted#key')")
        field.press('Control+v')
        assert field.input_value() == 'dummy-pasted#key'
        field.fill('')
        page.locator('.key-controls button').first.click()
        page.wait_for_function("() => document.getElementById('provider-key-zai').value === 'dummy-pasted#key'")
        page.locator('[name=enabled]').check()
        page.locator('.provider-form button[type=submit]').click()
        page.wait_for_function("() => document.querySelector('[data-key-status]').textContent === 'Ключ сохранён'")
        assert field.input_value() == ''
        assert json.loads((Path(fixture['dir']) / 'credentials.json').read_text())['values']['DUMMY_KEY'] == 'dummy-pasted#key'
        page.reload()
        page.locator('[data-key-status]').wait_for()
        assert page.locator('[data-key-status]').inner_text() == 'Ключ сохранён'
        assert field.input_value() == ''
        page.screenshot(path=str(Path(tempfile.gettempdir()) / 'prorab-settings-compact.png'), full_page=True)
        page.locator('[data-tab=control]').click()
        for width, height in [(1000, 640), (900, 600), (800, 540)]:
            page.set_viewport_size({'width': width, 'height': height})
            bounds = page.locator('#run-form button[type=submit]').bounding_box()
            assert bounds['y'] + bounds['height'] <= height, (width, height, bounds)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.set_viewport_size({'width': 1000, 'height': 640})
        page.screenshot(path=str(Path(tempfile.gettempdir()) / 'prorab-workspace-compact.png'))
        assert not errors, errors
        browser.close()
    print('PASS: typed key survives polling, keyboard/button paste, save indicator, profile persistence, reload, send button fits 3 compact windows')
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
