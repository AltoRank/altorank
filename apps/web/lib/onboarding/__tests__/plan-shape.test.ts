import { expect, it } from "vitest";
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
