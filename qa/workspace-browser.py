"""Project/session/plan UI regression. Requires Python Playwright and Chromium."""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
process = subprocess.Popen(['node', 'qa/workspace-fixture.mjs'], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    fixture = json.loads(process.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(fixture['base'] + '/?token=' + fixture['token'])
        page.wait_for_selector('#agent-select option', state='attached')
        page.locator('.project-disclosure summary').click()
        page.locator('#project-path').fill(fixture['other'])
        page.locator('#project-form button[type=submit]').click()
        page.wait_for_function("() => document.querySelector('#workspace-line').textContent.includes('Второй проект')")
        assert page.locator('#project-select').input_value() != 'default'
        page.locator('#agent-select').select_option('file-helper')
        page.locator('#model-select').select_option('test')
        page.locator('#task').fill('Составь план проверки проекта')
        page.locator('#run-form button[type=submit]').click()
        page.wait_for_function("() => document.querySelector('#conversation').textContent.includes('План сохранён')")
        assert page.locator('#plan-steps li').count() == 2
        assert page.locator('#agent-select').is_disabled()
        page.locator('#task').fill('Продолжи с учётом первой задачи')
        page.locator('#run-form button[type=submit]').click()
        page.wait_for_function("() => document.querySelectorAll('.chat-message.assistant').length===2 && document.querySelector('#conversation').textContent.includes('Помню первую задачу: Составь план')")
        page.reload()
        page.wait_for_selector('.chat-message.assistant')
        assert page.locator('.chat-message.assistant').count() == 2
        assert page.locator('#plan-steps li').count() == 2
        assert page.locator('#model-select').input_value() == 'test'
        page.locator('#new-session').click()
        assert page.locator('#agent-select').is_enabled()
        assert page.locator('.chat-message').count() == 0
        page.locator('#session-list button').first.click()
        page.wait_for_selector('.chat-message.assistant')
        assert page.locator('.chat-message.assistant').count() == 2
        for width in [320, 390, 768, 1280]:
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
        page.screenshot(path=str(Path(tempfile.gettempdir()) / 'prorab-workspace.png'), full_page=True)
        assert not errors, errors
        browser.close()
    print('PASS: add project, explicit model, plan, two-turn conversation, reload, new/reopen session, 4 widths, no JS errors')
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
