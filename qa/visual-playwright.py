"""Browser layout/UI smoke test using real Chromium, mocked network (container disallows localhost browser requests)."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,sys
r=Path(__file__).resolve().parents[1]
html=(r/'web/index.html').read_text()
html=html.replace('<link rel="stylesheet" href="/style.css">','').replace('<script src="/theme.js"></script>','').replace('<script src="/app.js" defer></script>','')
css=(r/'web/style.css').read_text()
theme=(r/'web/theme.js').read_text()
script=(r/'web/app.js').read_text()
state={'workspace':'C:/Users/Test/Documents/Prorab','canConfigure':True,
 'agents':[{'id':'file-helper','name':'Файловый помощник','description':'Работа с файлами','tools':['list_files'],'mode':'manual','models':[],'localOnly':False}],
 'providers':[{'id':'gigachat','title':'GigaChat','model':'GigaChat-2-Pro','enabled':False,'privacy':'ru-cloud','ready':{'ok':False,'reason':'ключ не введён'},'usage':{'requests':0,'tokens':0},'limits':None,'note':''}], 'runs':[],'approvals':[]}
stub="""window.fetch=async()=>({ok:true,json:async()=>window.__MOCK_STATE});
window.EventSource=class{constructor(){} close(){}};"""
results=[]; errs=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for w in (320,360,390,414,768,1024,1280,1920):
  c=b.new_context(viewport={'width':w,'height':800})
  pg=c.new_page();pg.on('pageerror',lambda error:errs.append(str(error)))
  pg.set_content(html)
  pg.evaluate('() => { window.__MOCK_STATE = '+json.dumps(state,ensure_ascii=False)+';'+stub+' }')
  pg.add_style_tag(content=css)
  pg.add_script_tag(content=theme)
  pg.add_script_tag(content=script)
  pg.wait_for_timeout(120)
  no_scroll=pg.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
  results.append((f'{w}px no horizontal scroll',no_scroll))
  if w==390:
   results.append(('onboarding visible',pg.locator('#setup-guide').is_visible()))
   pg.locator('#go-setup').click()
   results.append(('onboarding button opens models',pg.locator('#tab-models').is_visible()))
   results.append(('model save form visible',pg.locator('.provider-form').is_visible()))
   pg.locator('#theme-toggle').click()
   results.append(('dark theme',pg.evaluate('getComputedStyle(document.body).backgroundColor')=='rgb(18, 18, 18)'))
   pg.screenshot(path='/mnt/data/prorab-work/visual-mobile.png',full_page=True)
  if w==1280:pg.screenshot(path='/mnt/data/prorab-work/visual-desktop.png',full_page=True)
  c.close()
 b.close()
results.append(('no browser JS errors',not errs))
for n,ok in results:print(('PASS' if ok else 'FAIL'),n)
print('RESULT',sum(ok for _,ok in results),'/',len(results), 'errors:',errs)
sys.exit(0 if all(ok for _,ok in results) else 1)
