import { expect, it, vi } from "vitest";
const questions = vi.fn();
vi.mock("@/lib/keywords/questions", async () => ({...await vi.importActual<typeof import("@/lib/keywords/questions")>("@/lib/keywords/questions"),generateQualityQuestionsBatch:(...args:unknown[])=>questions(...args)}));
import { decoratePlannedKeywords } from "../plan";
it("derives an unset shape from the approved article task and preserves owner choices", async () => {
  const rows = [
    {id:"new",term:"conversion tracking software",intent:"commercial",article_subtype:null,opportunity:{status:"qualified",angle:"How to choose conversion tracking software"},quality_questions:[{id:"q",question:"What do you use?",answer:null}]},
    {id:"custom",term:"conversion tracking software",intent:"commercial",article_subtype:"reference",opportunity:{status:"qualified",angle:"How to choose conversion tracking software"},quality_questions:[{id:"q",question:"What do you use?",answer:null}]},
  ];
  const writes: unknown[] = [];
  const db = {from:()=>({select:()=>{const q={eq:()=>q,in:async()=>({data:rows,error:null})};return q;},update:(value:unknown)=>{writes.push(value);const q={eq:()=>q,then:(resolve:(r:unknown)=>void)=>resolve({error:null})};return q;}})};
  expect(await decoratePlannedKeywords(db as never,"workspace",["new","custom"])).toMatchObject({classified:1});
  expect(writes).toEqual([{article_type:"guide",article_subtype:"howTo"}]);
});


it("keeps the approved article shape without buying optional questions before choice", async () => {
  const rows = [{id:"topic",term:"project software",intent:"commercial",article_subtype:null,opportunity:{status:"qualified",angle:"How to choose project software"},quality_questions:[]}];
  const writes: unknown[] = [];
  const db = {from:()=>({select:()=>{const q={eq:()=>q,in:async()=>({data:rows,error:null})};return q;},update:(value:unknown)=>{writes.push(value);const q={eq:()=>q,then:(resolve:(r:unknown)=>void)=>resolve({error:null})};return q;}})};
  expect(await decoratePlannedKeywords(db as never,"workspace",["topic"],new Map(),{deferQuestions:true})).toEqual({classified:1,questioned:0});
  expect(writes).toEqual([{article_type:"guide",article_subtype:"howTo"}]);
  expect(questions).not.toHaveBeenCalled();
});
