"""Optional UI regression: Python Playwright and Chromium, no external model."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
process = subprocess.Popen(['node', 'qa/browser-fixture.mjs'], cwd=root,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    fixture = json.loads(process.stdout.readline())
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                                    headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(fixture['base'] + '/?token=' + fixture['token'])
        page.wait_for_selector('#agent-select option', state='attached')
        page.locator('[data-tab=memory]').click()
        page.locator('#memory-text').fill('Предпочитаю отчёты таблицей <script>ошибка</script>')
        page.locator('#memory-local').uncheck()
        page.locator('#memory-form button[type=submit]').click()
        page.locator('#memory-notes .card').wait_for()
        assert page.locator('#memory-notes .card').count() == 1
        assert page.locator('#memory-notes script').count() == 0
        page.reload()
        page.locator('#memory-notes .card').wait_for()
        page.get_by_role('button', name='Изменить', exact=True).click()
        page.locator('#memory-text').fill('Предпочитаю краткие отчёты')
        page.locator('#memory-form button[type=submit]').click()
        page.wait_for_function("() => document.querySelector('#memory-notes').textContent.includes('краткие')")
        page.locator('#memory-query').fill('несуществующаяфраза')
        page.locator('#memory-search button').click()
        page.wait_for_function("() => document.querySelector('#memory-notes').textContent.includes('Подходящих заметок нет')")
        page.locator('#memory-query').fill('')
        page.locator('#memory-search button').click()
        page.locator('#memory-notes .card').wait_for()
        page.locator('[data-tab=control]').click()
        page.locator('#agent-select').select_option('file-helper')
        page.locator('.composer-options summary').click()
        page.locator('#use-memory').check()
        page.locator('#criteria').fill('Добавить ровно одну строку')
        page.locator('#task').fill('допиши строку в привет.txt')
        page.locator('#run-form button[type=submit]').click()
        page.locator('.approval .btn').first.wait_for()
        page.locator('.approval .btn').first.click()
        page.wait_for_function("() => document.querySelector('#run-status').textContent.includes('Готово')")
        page.wait_for_function("() => document.querySelector('#log').textContent.includes('Память: подобрано записей — 1')")
        page.locator('[data-tab=memory]').click()
        page.locator('#memory-query').fill('допиши')
        page.locator('#memory-search button').click()
        page.locator('#memory-history .card').wait_for()
        page.get_by_role('button', name='Не использовать в памяти', exact=True).click()
        page.wait_for_function("() => !document.querySelector('#memory-history').textContent.includes('Не использовать в памяти')")
        page.get_by_role('button', name='Сохранить решение', exact=True).click()
        assert 'Готово: прочитал привет.txt' in page.locator('#memory-text').input_value()
        page.locator('#memory-form button[type=submit]').click()
        page.locator('#memory-query').fill('')
        page.locator('#memory-search button').click()
        page.wait_for_function("() => document.querySelectorAll('#memory-notes .card').length===2")
        page.on('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='Удалить', exact=True).first.click()
        page.wait_for_function("() => document.querySelectorAll('#memory-notes .card').length===1")
        for width in [320, 390, 768, 1280]:
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
        page.screenshot(path=str(Path(tempfile.gettempdir()) / 'prorab-memory.png'), full_page=True)
        assert not errors, errors
        browser.close()
    print('PASS: memory UI create/edit/reload/search/delete, history save/forget, recall event, approval, 4 widths, no JS errors')
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
