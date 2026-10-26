import json, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
process=subprocess.Popen(['node','qa/memory-upgrade-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    fixture=json.loads(process.stdout.readline())
    errors=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':1280,'height':900})
        page=context.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(fixture['base']+'/?token='+fixture['token'])
        page.wait_for_selector('#agent-select option',state='attached')
        response=context.request.post(fixture['base']+'/api/memory',data={'text':'Длиннаястрокабезпробелов'*70,'localOnly':True})
        assert response.ok
        for theme in ['light','dark']:
            page.evaluate('(t)=>{localStorage.setItem("prorab-theme",t)}',theme)
            page.reload()
            page.locator('[data-tab=memory]').click()
            page.locator('#memory-notes .card').first.wait_for()
            for width in [320,360,390,414,768,1024,1280,1920]:
                page.set_viewport_size({'width':width,'height':900})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),(theme,width)
                assert page.locator('#memory-form button[type=submit]').is_visible()
                for field in ['#memory-topic','#memory-path']:
                    assert page.locator(field).evaluate('(e)=>parseFloat(getComputedStyle(e).height) >= 40'),(theme,width,field)
            page.set_viewport_size({'width':1280,'height':900})
            page.evaluate('document.body.style.zoom="2"')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),(theme,'zoom 200%')
            page.evaluate('document.body.style.zoom="1"')
        page.set_viewport_size({'width':390,'height':900})
        page.screenshot(path=str(Path(tempfile.gettempdir())/'prorab-qa-memory-dark-390.png'),full_page=True)
        page.locator('#memory-text').fill('Не терять этот черновик при обрыве сети')
        context.set_offline(True)
        page.wait_for_function('() => !document.querySelector("#status-line").hidden',timeout=10000)
        assert 'Нет связи' in page.locator('#status-line').inner_text()
        assert page.locator('#memory-text').input_value()=='Не терять этот черновик при обрыве сети'
        context.set_offline(False)
        page.wait_for_function('() => document.querySelector("#status-line").hidden',timeout=10000)
        assert page.locator('#memory-text').input_value()=='Не терять этот черновик при обрыве сети'
        assert not errors,errors
        browser.close()
    print('PASS: 8 widths x light/dark, long unbroken text, CSS zoom 200%, offline banner/recovery and draft retained, no JS errors')
finally:
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait()
