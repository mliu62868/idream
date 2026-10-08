#!/usr/bin/env python3
"""Public FLEURS qualification. Never accepts production recordings or logs secrets.

prepare streams official archives and stops after N clips (no whole-corpus download).
run uses one resident Photon model. Derived quiet/noise are stress tests, not whispers.
Defaults qualify English product input; explicit --languages targets are research
only and do not expand the product's supported ASR languages. Set --output explicitly
for a separate research run so historical evidence remains identifiable.
"""
import argparse, array, csv, hashlib, json, math, os, pathlib, platform, random, resource, tarfile, time, unicodedata, urllib.request, uuid, wave
MODEL_REV = '2bf128600aac4b16946f7ed8372e56117fe5e23b'
CONFIGS = dict(zip('bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro ru sk sl es sv uk'.split(), 'bg_bg hr_hr cs_cz da_dk nl_nl en_us et_ee fi_fi fr_fr de_de el_gr hu_hu it_it lv_lv lt_lt mt_mt pl_pl pt_br ro_ro ru_ru sk_sk sl_si es_419 sv_se uk_ua'.split()))
ROOT = pathlib.Path('.scratch/chat-voice-input/qualification')

def fetch(url):
    for attempt in range(3):
        try: return urllib.request.urlopen(url, timeout=60)
        except Exception:
            if attempt == 2: raise
            time.sleep(1)

def write_wave(path, samples, rate):
    with wave.open(str(path), 'wb') as w:
        w.setparams((1, 2, rate, 0, 'NONE', 'not compressed')); w.writeframes(samples.tobytes())

def prepare_language(lang, args):
    config=CONFIGS[lang]; folder=ROOT/'audio'/lang; folder.mkdir(parents=True,exist_ok=True)
    metadata=ROOT/f'{config}-dev.tsv'
    rows={}
    previous=ROOT/f'{lang}-samples.json'
    if previous.exists():
        cached=json.loads(previous.read_text())
        if sum(row['condition']=='normal_human_read_speech' for row in cached)==args.count: return cached
    selected=[]
    with fetch(f'https://storage.googleapis.com/xtreme_translations/FLEURS102/{config}.tar.gz') as stream, tarfile.open(fileobj=stream, mode='r|gz') as archive:
        generation=stream.headers.get('x-goog-generation')
        for member in archive:
            name=pathlib.PurePosixPath(member.name).name
            if member.isfile() and member.name == f'{config}/dev.tsv':
                metadata.write_bytes(archive.extractfile(member).read())
                rows={r[1]:r for r in csv.reader(metadata.read_text().splitlines(),delimiter='\t')}
                continue
            if not member.isfile() or '/audio/dev/' not in member.name or name not in rows: continue
            if int(rows[name][5])>60*16000: continue
            raw=archive.extractfile(member).read(); path=folder/name; path.write_bytes(raw)
            row=rows[name]
            # Decode FLEURS float WAV with ffmpeg; explicitly record all transforms.
            import subprocess
            pcm=folder/f'{path.stem}-pcm.wav'
            subprocess.run(['ffmpeg','-v','error','-y','-i',str(path),'-ac','1','-ar','16000','-c:a','pcm_s16le',str(pcm)],check=True)
            path.unlink()
            with wave.open(str(pcm),'rb') as w: duration=w.getnframes()/w.getframerate()
            selected.append(dict(language=lang,id=row[0],path=str(pcm),reference=row[3],raw_reference=row[2],gender=row[6],speaker_id=None,source='Google FLEURS dev (official GCS original archive)' ,source_revision=f'gcs-generation:{generation}',source_url=f'https://storage.googleapis.com/xtreme_translations/FLEURS102/{config}.tar.gz?generation={generation}',license='CC-BY-4.0',condition='normal_human_read_speech',duration_s=duration,sha256=hashlib.sha256(pcm.read_bytes()).hexdigest()))
            if len(selected)>=args.count: break
    normal=list(selected)
    for i,record in enumerate(normal[:5]):
        with wave.open(record['path'],'rb') as w: samples=array.array('h',w.readframes(w.getnframes())); rate=w.getframerate()
        rms=math.sqrt(sum(v*v for v in samples)/max(1,len(samples))); rng=random.Random(i)
        for label,derived in [('synthetic_attenuation_minus20db',array.array('h',(round(v*0.1) for v in samples))),('synthetic_white_noise_snr10db',array.array('h',(max(-32768,min(32767,round(v+rng.gauss(0,rms/math.sqrt(10))))) for v in samples)))]:
            path=folder/f'{pathlib.Path(record["path"]).stem}-{label}.wav';write_wave(path,derived,rate)
            selected.append({**record,'path':str(path),'condition':label,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    previous.write_text(json.dumps(selected,ensure_ascii=False,indent=2))
    print(f'prepared {lang}: {len(selected)} clips',flush=True)
    return selected

def prepare(args):
    from concurrent.futures import ThreadPoolExecutor
    ROOT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        groups=list(pool.map(lambda lang: prepare_language(lang,args),args.languages.split(",")))
    records=[row for group in groups for row in group]
    for seconds in [1,10,60]:
        path=ROOT/f'silence-{seconds}s.wav';write_wave(path,array.array('h',[0]*(16000*seconds)),16000)
        records.append(dict(language='none',path=str(path),reference='',condition='synthetic_digital_silence',duration_s=seconds))
    (ROOT/'manifest.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))

def words(text):
    normalized=unicodedata.normalize('NFKC',text).lower()
    return ''.join(c if c.isalnum() or c.isspace() else ' ' for c in normalized).split()

def edits(reference,hypothesis):
    a,b=words(reference),words(hypothesis);prev=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        current=[i]
        for j,y in enumerate(b,1): current.append(min(current[-1]+1,prev[j]+1,prev[j-1]+(x!=y)))
        prev=current
    return prev[-1],len(a)

def run(args):
    os.environ['HF_HUB_OFFLINE']='1'
    import moondream as md
    import importlib.metadata
    records=json.loads((ROOT/'manifest.json').read_text()) if (ROOT/'manifest.json').exists() else [row for file in sorted(ROOT.glob('*-samples.json')) for row in json.loads(file.read_text())]
    for seconds in [1,10,60]:
        path=ROOT/f'silence-{seconds}s.wav'
        if not path.exists(): write_wave(path,array.array('h',[0]*(16000*seconds)),16000)
        if not any(row['path']==str(path) for row in records): records.append(dict(language='none',path=str(path),reference='',condition='synthetic_digital_silence',duration_s=seconds))
    selected=[r for r in records if not args.languages or r['language'] in args.languages.split(',') or r['language']=='none']
    output=ROOT/args.output
    from huggingface_hub import snapshot_download
    cache=snapshot_download('moondream/parakeet-redux',revision=MODEL_REV,local_files_only=True)
    hardware=dict(machine=platform.machine(),processor=platform.processor(),platform=platform.platform(),cpu_count=os.cpu_count())
    if platform.system()=='Darwin': hardware['cpu_model']=__import__('subprocess').check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip()
    metadata=dict(provider='photon',model='moondream/parakeet-redux',revision=MODEL_REV,runtime=importlib.metadata.version('moondream'),hardware=hardware,device=args.device,source_revision=__import__('subprocess').check_output(['node','scripts/source-revision.cjs'],text=True).strip(),score='NFKC/lower/unicode-punctuation-space token Levenshtein; NOT official leaderboard compound-merging normalizer',qualification_limits=['No verified speaker IDs','No genuine whisper or environmental-noise recordings','No human critical-meaning adjudication','FLEURS read speech does not represent companion dictation'])
    metadata['probe_sha256']=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    metadata['git_commit']=__import__('subprocess').check_output(['git','rev-parse','HEAD'],text=True).strip()
    (ROOT/'runtime.json').write_text(json.dumps(metadata,indent=2))
    start=time.monotonic()
    with md.photon("moondream/parakeet-redux",api_key="",model_path=cache,device=args.device,single_pass_batch_capacity=1) as model:
        loaded_ms=round((time.monotonic()-start)*1000)
        with output.open('a') as f:
            completed=set()
            for line in output.read_text().splitlines():
                if line: completed.add(json.loads(line)['path'])
            for r in selected:
                if r['path'] in completed: continue
                request=str(uuid.uuid4());begin=time.monotonic()
                try:
                    result=model.transcribe(audio=r['path']);text=result['text'];error=None
                except Exception as exc: text='';error=f'{type(exc).__name__}: {exc}'
                latency=round((time.monotonic()-begin)*1000,2);distance,count=edits(r['reference'],text)
                evidence={**r,'audio_source_revision':r.get('source_revision'),'request_id':request,'attempt_id':request,'transcript':text,'error':error,'latency_ms':latency,'edit_distance':distance,'reference_words':count,'model_load_ms':loaded_ms,'max_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if platform.system()=='Darwin' else 1024),**metadata}
                f.write(json.dumps(evidence,ensure_ascii=False)+'\n');f.flush()
                print(r['language'],r['condition'],latency,'WER',round(distance/max(1,count)*100,2),flush=True)
    summarize(output)

def summarize(output):
    rows=[json.loads(line) for line in output.read_text().splitlines() if line];groups={}
    for r in rows:groups.setdefault((r['language'],r['condition']),[]).append(r)
    summary=[]
    for (language,condition),group in groups.items():
        total=sum(r['reference_words'] for r in group);latency=sorted(r['latency_ms'] for r in group)
        summary.append(dict(language=language,condition=condition,n=len(group),total_audio_duration_s=round(sum(r['duration_s'] for r in group),2),audio_seconds_per_wall_second=round(sum(r['duration_s'] for r in group)/(sum(r['latency_ms'] for r in group)/1000),2),max_rss_bytes=max(r['max_rss_bytes'] for r in group),wer_pct=round(sum(r['edit_distance'] for r in group)/total*100,2) if total else None,failures=sum(bool(r['error']) for r in group),p95_ms=latency[max(0,math.ceil(len(latency)*.95)-1)],hallucinations=sum(bool(r['transcript'].strip()) for r in group) if not total else None))
    for row in summary:
        threshold=10 if row['condition']=='normal_human_read_speech' else 20
        row['screen_pass']=row['failures']==0 and (row['hallucinations']==0 if row['wer_pct'] is None else row['wer_pct']<=threshold)
    output.with_suffix('.summary.json').write_text(json.dumps(summary,indent=2))
    if not all(row['screen_pass'] for row in summary):
        raise SystemExit(1)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    prep=sub.add_parser('prepare');prep.add_argument('--languages',default='en');prep.add_argument('--count',type=int,default=20)
    runp=sub.add_parser('run');runp.add_argument('--languages',default='en');runp.add_argument('--device',default='cpu',choices=['cpu','mps','cuda']);runp.add_argument('--output',default='results-english.jsonl')
    args=p.parse_args()
    if args.command=='prepare' and not 1<=args.count<=100: p.error('--count must be between 1 and 100')
    if args.languages and any(lang not in CONFIGS for lang in args.languages.split(',')): p.error('unknown target language')
    prepare(args) if args.command=='prepare' else run(args)
