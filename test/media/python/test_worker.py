import importlib.util,json,pathlib,tempfile,unittest
spec=importlib.util.spec_from_file_location('worker', pathlib.Path.cwd()/'src/media/pdf-ocr-worker.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

class Runner:
 def __init__(self, stop=None):self.calls=[];self.stop=stop;self.closed=False
 def process(self,page,notify):
  self.calls.append(page)
  if page==self.stop:raise KeyboardInterrupt()
  return {'status':'ocr','text':f'page {page}','lines':[],'retries':0,'unresolved':[]}
 def close(self):self.closed=True

class Tests(unittest.TestCase):
 def test_resume_after_interrupt_and_corrupt_page(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);a=Runner(stop=3)
   with self.assertRaises(KeyboardInterrupt):w.process_pages(p,[1,2,3,4],'fingerprint',a,lambda _:None)
   self.assertTrue(a.closed)
   b=Runner();r=w.process_pages(p,[1,2,3,4],'fingerprint',b,lambda _:None)
   self.assertEqual(b.calls,[3,4]);self.assertEqual(len(r),4)
   value=json.loads(w.record_path(p,2).read_text());value['text']='corrupt';w.record_path(p,2).write_text(json.dumps(value))
   c=Runner();w.process_pages(p,[1,2,3,4],'fingerprint',c,lambda _:None);self.assertEqual(c.calls,[2])
   c=Runner();w.process_pages(p,[1,2,3,4],'new-fingerprint',c,lambda _:None);self.assertEqual(c.calls,[1,2,3,4])
 def test_failed_page_does_not_stop_other_pages_and_is_retried(self):
  class Failing(Runner):
   def process(self,page,notify):
    if page==2:raise TimeoutError()
    return super().process(page,notify)
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);r=w.process_pages(p,[1,2,3],'fingerprint',Failing(),lambda _:None)
   self.assertEqual(r[2]['status'],'error');self.assertEqual(r[3]['status'],'ocr')
   report=w.write_report(p,r,3);self.assertEqual(report['reviewRanges'],'2')
   next=Runner();w.process_pages(p,[1,2,3],'fingerprint',next,lambda _:None);self.assertEqual(next.calls,[2])
 def test_quality_retry_rejects_short_or_worse_output(self):
  old=[{'text':'abcdefghij','confidence':.8,'box':[.1,.1,.8,.2]}]
  self.assertFalse(w.choose_retry(old,[{'text':'a','confidence':.99}])[1])
  self.assertFalse(w.choose_retry(old,[{'text':'abcdefghij','confidence':.7}])[1])
  self.assertTrue(w.choose_retry(old,[{'text':'abcdefghij','confidence':.95}])[1])
 def test_native_header_does_not_hide_scanned_body(self):
  self.assertFalse(w.can_use_native('header '*10, [[0,0,100,90]],10000))
  self.assertTrue(w.can_use_native('text '*30, [],10000))
 def test_partial_recovery_is_preserved_for_review(self):
  candidate=[{'text':'recovered text','confidence':.89,'box':[0,0,1,1]}]
  self.assertEqual(w.choose_retry([],candidate),(candidate,True))
  self.assertEqual(len(w.unclear(candidate)),1)
 def test_blurry_regions_and_ranges(self):
  lines=[{'text':'a','confidence':.7,'box':[.1,.1,.2,.2]}, {'text':'b','confidence':.99,'box':[.2,.4,.3,.5]}]
  regions=w.retry_regions(lines);self.assertEqual(len(regions),1);self.assertLess(regions[0][0],.1)
  self.assertEqual(w.page_ranges([5,2,1,2,6,9]),'1-2, 5-6, 9')
if __name__=='__main__':unittest.main()
