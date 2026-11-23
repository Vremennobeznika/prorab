"""New memory consent, conflicts, project scope and reviewer UI, using a local fake model."""
import json
import os
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[1]
process = subprocess.Popen(['node', 'qa/memory-upgrade-fixture.mjs'], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    fixture = json.loads(process.stdout.readline())
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(fixture['base'] + '/?token=' + fixture['token'])
        page.wait_for_selector('#agent-select option', state='attached')
        page.locator('.composer-options summary').click()
        page.locator('#use-memory').check()
        page.locator('#learn-memory').check()
        page.locator('#verify-result').check()
        page.locator('#task').fill('Использовать Node 22')
        page.locator('#run-form button[type=submit]').click()
        page.wait_for_function("() => document.querySelector('#run-status').textContent.includes('Готово')")
        page.wait_for_function("() => document.querySelector('#log').textContent.includes('Предложения памяти: 1')")
        page.locator('[data-tab=memory]').click()
        page.locator('#memory-suggestions .card').wait_for()
        assert 'Использовать Node 22' in page.locator('#memory-suggestions').inner_text()
        assert 'Использовать Node 20' in page.locator('#memory-notes').inner_text()
        page.locator('#memory-suggestions').get_by_role('button', name='Заменить:', exact=False).click()
        page.wait_for_function("() => document.querySelectorAll('#memory-suggestions .card').length === 0")
        assert page.locator('#memory-notes .card').count() == 1
        assert 'Использовать Node 22' in page.locator('#memory-notes').inner_text()
        page.locator('#memory-retired').check()
        page.wait_for_function("() => document.querySelectorAll('#memory-notes .card').length === 2")
        page.reload()
        page.locator('[data-tab=memory]').click()
        page.locator('#memory-notes .card').wait_for()
        assert 'Использовать Node 22' in page.locator('#memory-notes').inner_text()
        page.locator('#memory-notes').get_by_role('button', name='Изменить', exact=True).first.click()
        assert page.locator('#memory-scope').input_value() == fixture['workspace']
        assert page.locator('#memory-kind').input_value() == 'decision'
        assert page.locator('#memory-topic').input_value() == 'Node'
        for width in [360, 390, 768, 1280]:
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
        assert not errors, errors
        browser.close()
    print('PASS: UI memory opt-in, separate review, grounded proposal, explicit conflict replacement, archive, scope/type/topic persistence, 4 widths, no JS errors')
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
