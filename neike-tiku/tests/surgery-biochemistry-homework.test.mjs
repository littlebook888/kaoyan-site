import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
const read = name => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)))
const surgery = read('surgery-teacher-supplement')
const bio = read('biochemistry-teacher-supplement')

test('homework source questions are complete, unique and have scoped answers', () => {
  for (const [d,count] of [[surgery,103],[bio,23]]) {
    assert.equal(d.groups.flatMap(g=>g.stems).length,count)
    assert.equal(new Set(d.groups.map(g=>g.id)).size,d.groups.length)
    const identities = new Set()
    for (const g of d.groups) {
      assert.equal(g.lectureIds.length,1)
      assert.ok(g.hideSource,'no fictitious DOCX page zero')
      for (const s of g.stems) {
        const identity = `${g.sourceSection}:${s.number}`
        assert.ok(!identities.has(identity),identity)
        identities.add(identity)
        const opts = g.options.filter(o=>!s.optionCategory||o.category===s.optionCategory)
        assert.equal(opts.length,4,identity)
        assert.equal(s.lectureId,g.lectureIds[0])
        assert.ok(s.answer.length&&s.answer.every(k=>opts.some(o=>o.key===k)),identity)
        assert.equal(s.answer.map(k=>{const o=opts.find(o=>o.key===k);return o.displayKey||o.key}).join(''),s.answerRaw)
        assert.equal(s.answerMode,s.answer.length>1?'多选':'单选')
        assert.ok(!s.text.includes('（接上题）'))
      }
      if (g.stems.length>1) assert.ok(g.sharedStem&&g.sharedQuestionCount===g.stems.length)
    }
  }
})

test('chapters resolve to actual lectures and pancreatitis is not pancreatic cancer', () => {
  const ids = new Set([...read('surgery-data').lectures,...surgery.lectures].map(l=>l.id))
  for (const g of surgery.groups) assert.ok(ids.has(g.lectureIds[0]),g.id)
  for (const g of bio.groups) assert.match(g.lectureIds[0],/^lecture-(0[1-9]|1\d|20)$/)
  const groups = surgery.groups.filter(g=>g.lectureIds.includes('med-lecture-23'))
  assert.equal(groups.flatMap(g=>g.stems).length,6)
  assert.ok(groups.every(g=>g.topic==='肝胆胰疾病'))
  assert.match(surgery.lectures[0].title,/胰腺炎/)
})

test('source omissions and representative shared/multi-select questions remain explicit', () => {
  assert.deepEqual(bio.meta.missingSourceQuestions,[8,9,13,18,22,24,26])
  assert.equal(bio.groups.find(g=>g.id==='biochemistry-teacher-01-01').lectureIds[0],'lecture-08')
  assert.equal(bio.groups.find(g=>g.id==='biochemistry-teacher-01-27').lectureIds[0],'lecture-14')
  assert.equal(surgery.groups.find(g=>g.id==='surgery-teacher-01-02').stems[0].answerRaw,'BC')
  const g=surgery.groups.find(g=>g.id==='surgery-teacher-06-21-23')
  assert.deepEqual(g.stems.map(s=>s.answerRaw),['D','A','A'])
  assert.equal(g.lectureIds[0],'lecture-25')
})
