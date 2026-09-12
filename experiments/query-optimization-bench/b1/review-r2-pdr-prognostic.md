# r2-pdr-prognostic: 人手判断が必要な行（9 件、参照先からの伝播を含む）

## 行 45

元の式: rubeosis iridis*.tw.

- 理由: rubeosis iridis*: unknown truncated stems iridis*

## 行 47

元の式: or/30‐46

- 理由: unsupported reference 45
- 理由: empty reference 45

## 行 50

元の式: fibro?proliferative disease*.tw.

- 理由: fibro?proliferative

## 行 60

元の式: partial* sight*.tw.

- 理由: partial* sight*: unknown truncated stems partial*, sight*

## 行 61

元の式: or/48‐60

- 理由: unsupported reference 50
- 理由: empty reference 50
- 理由: unsupported reference 60
- 理由: empty reference 60

## 行 66

元の式: relationship* between.tw.

- 理由: relationship* between: unknown truncated stems relationship*

## 行 71

元の式: natural histor*.tw.

- 理由: natural histor*: unknown truncated stems histor*

## 行 73

元の式: or/62‐72

- 理由: unsupported reference 66
- 理由: empty reference 66
- 理由: unsupported reference 71
- 理由: empty reference 71

## 行 74

元の式: 29 and 47 and 61 and 73

- 理由: unsupported reference 47
- 理由: unsupported reference 61
- 理由: unsupported reference 73

## 変換記録（未解決のため計測禁止）

# r2-pdr-prognostic: Ovid → PubMed

明示ブリーフを優先: 切り捨てを伴う近接は AND、副標目は exp がない限り noexp。未知の ? は省略して要人手判断。

句内の切り捨ては known-words.json の完結した語に限り単複化し、それ以外は人手判断まで出力しない。

`.mp.` は tiab を出し、大小文字を除いて許可リストに完全一致し、切り捨てを含まない語だけ Mesh を追加する。

## 1

元: Risk Factors/

```text
"Risk Factors"[Mesh:noexp]
```

近似記録なし

## 2

元: risk factor*.tw.

```text
("risk factor"[tiab] OR "risk factors"[tiab])
```

- phrase_truncation: risk factor*: singular/plural expansion requires known complete words

## 3

元: Biomarkers/

```text
"Biomarkers"[Mesh:noexp]
```

近似記録なし

## 4

元: biomarker*.tw.

```text
biomarker*[tiab]
```

近似記録なし

## 5

元: marker*.tw.

```text
marker*[tiab]
```

近似記録なし

## 6

元: biological marker*.tw.

```text
("biological marker"[tiab] OR "biological markers"[tiab])
```

- phrase_truncation: biological marker*: singular/plural expansion requires known complete words

## 7

元: Vascular Endothelial Growth Factor A/

```text
"Vascular Endothelial Growth Factor A"[Mesh:noexp]
```

近似記録なし

## 8

元: Vascular Endothelial Growth Factor A.tw.

```text
"Vascular Endothelial Growth Factor A"[tiab]
```

近似記録なし

## 9

元: VEGF.tw.

```text
VEGF[tiab]
```

近似記録なし

## 10

元: "Intercellular Signaling Peptides and Proteins"/

```text
"Intercellular Signaling Peptides and Proteins"[Mesh:noexp]
```

近似記録なし

## 11

元: growth factor*.tw.

```text
("growth factor"[tiab] OR "growth factors"[tiab])
```

- phrase_truncation: growth factor*: singular/plural expansion requires known complete words

## 12

元: exp Erythropoietin/

```text
"Erythropoietin"[Mesh]
```

近似記録なし

## 13

元: erythropoietin*.tw.

```text
erythropoietin*[tiab]
```

近似記録なし

## 14

元: EPO.tw.

```text
EPO[tiab]
```

近似記録なし

## 15

元: retinal angiogenic factor*.tw.

```text
("retinal angiogenic factor"[tiab] OR "retinal angiogenic factors"[tiab])
```

- phrase_truncation: retinal angiogenic factor*: singular/plural expansion requires known complete words

## 16

元: exp Epidemiology/

```text
"Epidemiology"[Mesh]
```

近似記録なし

## 17

元: epidemiolog*.tw.

```text
epidemiolog*[tiab]
```

近似記録なし

## 18

元: potential role*.tw.

```text
("potential role"[tiab] OR "potential roles"[tiab])
```

- phrase_truncation: potential role*: singular/plural expansion requires known complete words

## 19

元: ((risk* or rate*) adj5 (progress* or complicat*)).tw.

```text
((risk*[tiab] OR rate*[tiab]) AND (progress*[tiab] OR complicat*[tiab]))
```

- proximity_to_and: (risk* or rate*) adj5 (progress* or complicat*)

## 20

元: Risk Assessment/

```text
"Risk Assessment"[Mesh:noexp]
```

近似記録なし

## 21

元: (risk* adj5 (assess* or stratif*)).tw.

```text
(risk*[tiab] AND (assess*[tiab] OR stratif*[tiab]))
```

- proximity_to_and: risk* adj5 (assess* or stratif*)

## 22

元: exp Phenotype/

```text
"Phenotype"[Mesh]
```

近似記録なし

## 23

元: phenotype*.tw.

```text
phenotype*[tiab]
```

近似記録なし

## 24

元: Prognosis/

```text
"Prognosis"[Mesh:noexp]
```

近似記録なし

## 25

元: prognos*.tw.

```text
prognos*[tiab]
```

近似記録なし

## 26

元: predict*.tw.

```text
predict*[tiab]
```

近似記録なし

## 27

元: model*.tw.

```text
model*[tiab]
```

近似記録なし

## 28

元: variable*.tw.

```text
variable*[tiab]
```

近似記録なし

## 29

元: or/1‐28

```text
(("Risk Factors"[Mesh:noexp]) OR (("risk factor"[tiab] OR "risk factors"[tiab])) OR ("Biomarkers"[Mesh:noexp]) OR (biomarker*[tiab]) OR (marker*[tiab]) OR (("biological marker"[tiab] OR "biological markers"[tiab])) OR ("Vascular Endothelial Growth Factor A"[Mesh:noexp]) OR ("Vascular Endothelial Growth Factor A"[tiab]) OR (VEGF[tiab]) OR ("Intercellular Signaling Peptides and Proteins"[Mesh:noexp]) OR (("growth factor"[tiab] OR "growth factors"[tiab])) OR ("Erythropoietin"[Mesh]) OR (erythropoietin*[tiab]) OR (EPO[tiab]) OR (("retinal angiogenic factor"[tiab] OR "retinal angiogenic factors"[tiab])) OR ("Epidemiology"[Mesh]) OR (epidemiolog*[tiab]) OR (("potential role"[tiab] OR "potential roles"[tiab])) OR (((risk*[tiab] OR rate*[tiab]) AND (progress*[tiab] OR complicat*[tiab]))) OR ("Risk Assessment"[Mesh:noexp]) OR ((risk*[tiab] AND (assess*[tiab] OR stratif*[tiab]))) OR ("Phenotype"[Mesh]) OR (phenotype*[tiab]) OR ("Prognosis"[Mesh:noexp]) OR (prognos*[tiab]) OR (predict*[tiab]) OR (model*[tiab]) OR (variable*[tiab]))
```

近似記録なし

## 30

元: Diabetic Retinopathy/

```text
"Diabetic Retinopathy"[Mesh:noexp]
```

近似記録なし

## 31

元: proliferative diabetic retinopathy*.tw.

```text
("proliferative diabetic retinopathy"[tiab] OR "proliferative diabetic retinopathies"[tiab])
```

- phrase_truncation: proliferative diabetic retinopathy*: singular/plural expansion requires known complete words

## 32

元: PDR.tw.

```text
PDR[tiab]
```

近似記録なし

## 33

元: non?proliferative diabetic retinopathy*.tw.

```text
("nonproliferative diabetic retinopathy"[tiab] OR "nonproliferative diabetic retinopathies"[tiab] OR "non proliferative diabetic retinopathy"[tiab] OR "non proliferative diabetic retinopathies"[tiab])
```

- phrase_truncation: non?proliferative diabetic retinopathy*: singular/plural expansion requires known complete words
- wildcard_expanded: non?proliferative → nonproliferative OR non proliferative

## 34

元: NPDR.tw.

```text
NPDR[tiab]
```

近似記録なし

## 35

元: (complication* adj5 (diabetic retinopathy* or DR)).tw.

```text
(complication*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))
```

- proximity_to_and: complication* adj5 (diabetic retinopathy* or DR)
- phrase_truncation: diabetic retinopathy*: singular/plural expansion requires known complete words

## 36

元: (microvascular complication* adj5 diabet*).tw.

```text
(("microvascular complication"[tiab] OR "microvascular complications"[tiab]) AND diabet*[tiab])
```

- proximity_to_and: microvascular complication* adj5 diabet*
- phrase_truncation: microvascular complication*: singular/plural expansion requires known complete words

## 37

元: (severity* adj5 (diabetic retinopathy* or DR)).tw.

```text
(severity*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))
```

- proximity_to_and: severity* adj5 (diabetic retinopathy* or DR)
- phrase_truncation: diabetic retinopathy*: singular/plural expansion requires known complete words

## 38

元: (advanced adj5 (diabetic retinopathy* or DR*)).tw.

```text
(advanced[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR*[tiab]))
```

- proximity_to_and: advanced adj5 (diabetic retinopathy* or DR*)
- phrase_truncation: diabetic retinopathy*: singular/plural expansion requires known complete words

## 39

元: severe retinopathy*.tw.

```text
("severe retinopathy"[tiab] OR "severe retinopathies"[tiab])
```

- phrase_truncation: severe retinopathy*: singular/plural expansion requires known complete words

## 40

元: Retinal Neovascularization/

```text
"Retinal Neovascularization"[Mesh:noexp]
```

近似記録なし

## 41

元: (retina* adj5 neo?vasculari*).tw.

```text
(retina*[tiab] AND (neovascularis*[tiab] OR neovasculariz*[tiab]))
```

- proximity_to_and: retina* adj5 neo?vasculari*
- wildcard_expanded: neo?vasculari* → neovascularis* OR neovasculariz*

## 42

元: new vessel*.tw.

```text
("new vessel"[tiab] OR "new vessels"[tiab])
```

- phrase_truncation: new vessel*: singular/plural expansion requires known complete words

## 43

元: ((neovasculari* or new vessel*) adj5 (disc* or retina* or elsewhere or iris*)).tw.

```text
((neovasculari*[tiab] OR ("new vessel"[tiab] OR "new vessels"[tiab])) AND (disc*[tiab] OR retina*[tiab] OR elsewhere[tiab] OR iris*[tiab]))
```

- proximity_to_and: (neovasculari* or new vessel*) adj5 (disc* or retina* or elsewhere or iris*)
- phrase_truncation: new vessel*: singular/plural expansion requires known complete words

## 44

元: (NVD or NVE or NVI).tw.

```text
(NVD[tiab] OR NVE[tiab] OR NVI[tiab])
```

近似記録なし

## 45

元: rubeosis iridis*.tw.

```text

```

- phrase_truncation: rubeosis iridis*: singular/plural expansion requires known complete words
- unsupported: rubeosis iridis*: unknown truncated stems iridis*

## 46

元: ((vision* or sight*) adj5 threat* adj25 (diabet* or retinopathy*)).tw.

```text
((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopathy*[tiab]))
```

- proximity_to_and: (vision* or sight*) adj5 threat* adj25 (diabet* or retinopathy*)

## 47

元: or/30‐46

```text
(("Diabetic Retinopathy"[Mesh:noexp]) OR (("proliferative diabetic retinopathy"[tiab] OR "proliferative diabetic retinopathies"[tiab])) OR (PDR[tiab]) OR (("nonproliferative diabetic retinopathy"[tiab] OR "nonproliferative diabetic retinopathies"[tiab] OR "non proliferative diabetic retinopathy"[tiab] OR "non proliferative diabetic retinopathies"[tiab])) OR (NPDR[tiab]) OR ((complication*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((("microvascular complication"[tiab] OR "microvascular complications"[tiab]) AND diabet*[tiab])) OR ((severity*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((advanced[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR*[tiab]))) OR (("severe retinopathy"[tiab] OR "severe retinopathies"[tiab])) OR ("Retinal Neovascularization"[Mesh:noexp]) OR ((retina*[tiab] AND (neovascularis*[tiab] OR neovasculariz*[tiab]))) OR (("new vessel"[tiab] OR "new vessels"[tiab])) OR (((neovasculari*[tiab] OR ("new vessel"[tiab] OR "new vessels"[tiab])) AND (disc*[tiab] OR retina*[tiab] OR elsewhere[tiab] OR iris*[tiab]))) OR ((NVD[tiab] OR NVE[tiab] OR NVI[tiab])) OR (((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopathy*[tiab]))))
```

- unsupported: unsupported reference 45
- unsupported: empty reference 45

## 48

元: Vitreous Hemorrhage/

```text
"Vitreous Hemorrhage"[Mesh:noexp]
```

近似記録なし

## 49

元: vitreous h?emorrhage*.tw.

```text
("vitreous hemorrhage"[tiab] OR "vitreous hemorrhages"[tiab] OR "vitreous haemorrhage"[tiab] OR "vitreous haemorrhages"[tiab])
```

- phrase_truncation: vitreous h?emorrhage*: singular/plural expansion requires known complete words
- wildcard_expanded: h?emorrhage* → hemorrhage* OR haemorrhage*

## 50

元: fibro?proliferative disease*.tw.

```text

```

- phrase_truncation: fibro?proliferative disease*: singular/plural expansion requires known complete words
- unsupported: fibro?proliferative

## 51

元: tractional retinal detachment*.tw.

```text
("tractional retinal detachment"[tiab] OR "tractional retinal detachments"[tiab])
```

- phrase_truncation: tractional retinal detachment*: singular/plural expansion requires known complete words

## 52

元: rhegmatogenous retinal detachment*.tw.

```text
("rhegmatogenous retinal detachment"[tiab] OR "rhegmatogenous retinal detachments"[tiab])
```

- phrase_truncation: rhegmatogenous retinal detachment*: singular/plural expansion requires known complete words

## 53

元: Glaucoma, Neovascular/

```text
"Glaucoma, Neovascular"[Mesh:noexp]
```

近似記録なし

## 54

元: neovascular glaucoma*.tw.

```text
("neovascular glaucoma"[tiab] OR "neovascular glaucomas"[tiab])
```

- phrase_truncation: neovascular glaucoma*: singular/plural expansion requires known complete words

## 55

元: NVG.tw.

```text
NVG[tiab]
```

近似記録なし

## 56

元: ((moderate* or severe* or reduced) adj5 vis*).tw.

```text
((moderate*[tiab] OR severe*[tiab] OR reduced[tiab]) AND vis*[tiab])
```

- proximity_to_and: (moderate* or severe* or reduced) adj5 vis*

## 57

元: Blindness/

```text
"Blindness"[Mesh:noexp]
```

近似記録なし

## 58

元: (registered adj5 blind).tw.

```text
"registered blind"[tiab:~4]
```

近似記録なし

## 59

元: blindness*.tw.

```text
blindness*[tiab]
```

近似記録なし

## 60

元: partial* sight*.tw.

```text

```

- phrase_truncation: partial* sight*: singular/plural expansion requires known complete words
- unsupported: partial* sight*: unknown truncated stems partial*, sight*

## 61

元: or/48‐60

```text
(("Vitreous Hemorrhage"[Mesh:noexp]) OR (("vitreous hemorrhage"[tiab] OR "vitreous hemorrhages"[tiab] OR "vitreous haemorrhage"[tiab] OR "vitreous haemorrhages"[tiab])) OR (("tractional retinal detachment"[tiab] OR "tractional retinal detachments"[tiab])) OR (("rhegmatogenous retinal detachment"[tiab] OR "rhegmatogenous retinal detachments"[tiab])) OR ("Glaucoma, Neovascular"[Mesh:noexp]) OR (("neovascular glaucoma"[tiab] OR "neovascular glaucomas"[tiab])) OR (NVG[tiab]) OR (((moderate*[tiab] OR severe*[tiab] OR reduced[tiab]) AND vis*[tiab])) OR ("Blindness"[Mesh:noexp]) OR ("registered blind"[tiab:~4]) OR (blindness*[tiab]))
```

- unsupported: unsupported reference 50
- unsupported: empty reference 50
- unsupported: unsupported reference 60
- unsupported: empty reference 60

## 62

元: occurrence*.tw.

```text
occurrence*[tiab]
```

近似記録なし

## 63

元: advancement*.tw.

```text
advancement*[tiab]
```

近似記録なし

## 64

元: worsen*.tw.

```text
worsen*[tiab]
```

近似記録なし

## 65

元: (evolution* or evolv*).tw.

```text
(evolution*[tiab] OR evolv*[tiab])
```

近似記録なし

## 66

元: relationship* between.tw.

```text

```

- phrase_truncation: relationship* between: singular/plural expansion requires known complete words
- unsupported: relationship* between: unknown truncated stems relationship*

## 67

元: Association/

```text
"Association"[Mesh:noexp]
```

近似記録なし

## 68

元: "correlation of data"/

```text
"correlation of data"[Mesh:noexp]
```

近似記録なし

## 69

元: incidence/ or prevalence/

```text
("incidence"[Mesh:noexp] OR "prevalence"[Mesh:noexp])
```

近似記録なし

## 70

元: exp disease progression/

```text
"disease progression"[Mesh]
```

近似記録なし

## 71

元: natural histor*.tw.

```text

```

- phrase_truncation: natural histor*: singular/plural expansion requires known complete words
- unsupported: natural histor*: unknown truncated stems histor*

## 72

元: natural course*.tw.

```text
("natural course"[tiab] OR "natural courses"[tiab])
```

- phrase_truncation: natural course*: singular/plural expansion requires known complete words

## 73

元: or/62‐72

```text
((occurrence*[tiab]) OR (advancement*[tiab]) OR (worsen*[tiab]) OR ((evolution*[tiab] OR evolv*[tiab])) OR ("Association"[Mesh:noexp]) OR ("correlation of data"[Mesh:noexp]) OR (("incidence"[Mesh:noexp] OR "prevalence"[Mesh:noexp])) OR ("disease progression"[Mesh]) OR (("natural course"[tiab] OR "natural courses"[tiab])))
```

- unsupported: unsupported reference 66
- unsupported: empty reference 66
- unsupported: unsupported reference 71
- unsupported: empty reference 71

## 74

元: 29 and 47 and 61 and 73

```text
(((("Risk Factors"[Mesh:noexp]) OR (("risk factor"[tiab] OR "risk factors"[tiab])) OR ("Biomarkers"[Mesh:noexp]) OR (biomarker*[tiab]) OR (marker*[tiab]) OR (("biological marker"[tiab] OR "biological markers"[tiab])) OR ("Vascular Endothelial Growth Factor A"[Mesh:noexp]) OR ("Vascular Endothelial Growth Factor A"[tiab]) OR (VEGF[tiab]) OR ("Intercellular Signaling Peptides and Proteins"[Mesh:noexp]) OR (("growth factor"[tiab] OR "growth factors"[tiab])) OR ("Erythropoietin"[Mesh]) OR (erythropoietin*[tiab]) OR (EPO[tiab]) OR (("retinal angiogenic factor"[tiab] OR "retinal angiogenic factors"[tiab])) OR ("Epidemiology"[Mesh]) OR (epidemiolog*[tiab]) OR (("potential role"[tiab] OR "potential roles"[tiab])) OR (((risk*[tiab] OR rate*[tiab]) AND (progress*[tiab] OR complicat*[tiab]))) OR ("Risk Assessment"[Mesh:noexp]) OR ((risk*[tiab] AND (assess*[tiab] OR stratif*[tiab]))) OR ("Phenotype"[Mesh]) OR (phenotype*[tiab]) OR ("Prognosis"[Mesh:noexp]) OR (prognos*[tiab]) OR (predict*[tiab]) OR (model*[tiab]) OR (variable*[tiab]))) AND ((("Diabetic Retinopathy"[Mesh:noexp]) OR (("proliferative diabetic retinopathy"[tiab] OR "proliferative diabetic retinopathies"[tiab])) OR (PDR[tiab]) OR (("nonproliferative diabetic retinopathy"[tiab] OR "nonproliferative diabetic retinopathies"[tiab] OR "non proliferative diabetic retinopathy"[tiab] OR "non proliferative diabetic retinopathies"[tiab])) OR (NPDR[tiab]) OR ((complication*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((("microvascular complication"[tiab] OR "microvascular complications"[tiab]) AND diabet*[tiab])) OR ((severity*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((advanced[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR*[tiab]))) OR (("severe retinopathy"[tiab] OR "severe retinopathies"[tiab])) OR ("Retinal Neovascularization"[Mesh:noexp]) OR ((retina*[tiab] AND (neovascularis*[tiab] OR neovasculariz*[tiab]))) OR (("new vessel"[tiab] OR "new vessels"[tiab])) OR (((neovasculari*[tiab] OR ("new vessel"[tiab] OR "new vessels"[tiab])) AND (disc*[tiab] OR retina*[tiab] OR elsewhere[tiab] OR iris*[tiab]))) OR ((NVD[tiab] OR NVE[tiab] OR NVI[tiab])) OR (((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopathy*[tiab]))))) AND ((("Vitreous Hemorrhage"[Mesh:noexp]) OR (("vitreous hemorrhage"[tiab] OR "vitreous hemorrhages"[tiab] OR "vitreous haemorrhage"[tiab] OR "vitreous haemorrhages"[tiab])) OR (("tractional retinal detachment"[tiab] OR "tractional retinal detachments"[tiab])) OR (("rhegmatogenous retinal detachment"[tiab] OR "rhegmatogenous retinal detachments"[tiab])) OR ("Glaucoma, Neovascular"[Mesh:noexp]) OR (("neovascular glaucoma"[tiab] OR "neovascular glaucomas"[tiab])) OR (NVG[tiab]) OR (((moderate*[tiab] OR severe*[tiab] OR reduced[tiab]) AND vis*[tiab])) OR ("Blindness"[Mesh:noexp]) OR ("registered blind"[tiab:~4]) OR (blindness*[tiab]))) AND (((occurrence*[tiab]) OR (advancement*[tiab]) OR (worsen*[tiab]) OR ((evolution*[tiab] OR evolv*[tiab])) OR ("Association"[Mesh:noexp]) OR ("correlation of data"[Mesh:noexp]) OR (("incidence"[Mesh:noexp] OR "prevalence"[Mesh:noexp])) OR ("disease progression"[Mesh]) OR (("natural course"[tiab] OR "natural courses"[tiab])))))
```

- unsupported: unsupported reference 47
- unsupported: unsupported reference 61
- unsupported: unsupported reference 73

## Unsupported（人手判断が必要）

- 45: rubeosis iridis*: unknown truncated stems iridis*

- 47: unsupported reference 45

- 47: empty reference 45

- 50: fibro?proliferative

- 60: partial* sight*: unknown truncated stems partial*, sight*

- 61: unsupported reference 50

- 61: empty reference 50

- 61: unsupported reference 60

- 61: empty reference 60

- 66: relationship* between: unknown truncated stems relationship*

- 71: natural histor*: unknown truncated stems histor*

- 73: unsupported reference 66

- 73: empty reference 66

- 73: unsupported reference 71

- 73: empty reference 71

- 74: unsupported reference 47

- 74: unsupported reference 61

- 74: unsupported reference 73

## 人手期待値との差分

比較では大小文字・冗長括弧・AND/OR 内の順序と重複を正規化し、履歴参照を完全展開する。

### 35

期待: (complicat*[tiab] AND ("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab] OR DR[tiab]))

実際:

```text
(complication*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 37

期待: (severit*[tiab] AND ("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab] OR DR[tiab]))

実際:

```text
(severity*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 41

期待: (retina*[tiab] AND neovasculari*[tiab])

実際:

```text
(retina*[tiab] AND (neovascularis*[tiab] OR neovasculariz*[tiab]))
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 45

期待: "rubeosis iridis"[tiab]

実際:

```text

```

原因の推測: 未対応のワイルドカードまたは句内語幹を省略・要人手判断

### 46

期待: ((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopath*[tiab]))

実際:

```text
((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopathy*[tiab]))
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 47

期待: (#30 OR … OR #46)

実際:

```text
(("Diabetic Retinopathy"[Mesh:noexp]) OR (("proliferative diabetic retinopathy"[tiab] OR "proliferative diabetic retinopathies"[tiab])) OR (PDR[tiab]) OR (("nonproliferative diabetic retinopathy"[tiab] OR "nonproliferative diabetic retinopathies"[tiab] OR "non proliferative diabetic retinopathy"[tiab] OR "non proliferative diabetic retinopathies"[tiab])) OR (NPDR[tiab]) OR ((complication*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((("microvascular complication"[tiab] OR "microvascular complications"[tiab]) AND diabet*[tiab])) OR ((severity*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((advanced[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR*[tiab]))) OR (("severe retinopathy"[tiab] OR "severe retinopathies"[tiab])) OR ("Retinal Neovascularization"[Mesh:noexp]) OR ((retina*[tiab] AND (neovascularis*[tiab] OR neovasculariz*[tiab]))) OR (("new vessel"[tiab] OR "new vessels"[tiab])) OR (((neovasculari*[tiab] OR ("new vessel"[tiab] OR "new vessels"[tiab])) AND (disc*[tiab] OR retina*[tiab] OR elsewhere[tiab] OR iris*[tiab]))) OR ((NVD[tiab] OR NVE[tiab] OR NVI[tiab])) OR (((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopathy*[tiab]))))
```

原因の推測: 参照先の差が伝播

### 50

期待: ("fibroproliferative disease"[tiab] OR "fibroproliferative diseases"[tiab] OR "fibro proliferative disease"[tiab] OR "fibro proliferative diseases"[tiab])

実際:

```text

```

原因の推測: 未対応のワイルドカードまたは句内語幹を省略・要人手判断

### 60

期待: ("partial sight"[tiab] OR "partially sighted"[tiab] OR "partial sightedness"[tiab])

実際:

```text

```

原因の推測: 未対応のワイルドカードまたは句内語幹を省略・要人手判断

### 61

期待: (#48 OR … OR #60)

実際:

```text
(("Vitreous Hemorrhage"[Mesh:noexp]) OR (("vitreous hemorrhage"[tiab] OR "vitreous hemorrhages"[tiab] OR "vitreous haemorrhage"[tiab] OR "vitreous haemorrhages"[tiab])) OR (("tractional retinal detachment"[tiab] OR "tractional retinal detachments"[tiab])) OR (("rhegmatogenous retinal detachment"[tiab] OR "rhegmatogenous retinal detachments"[tiab])) OR ("Glaucoma, Neovascular"[Mesh:noexp]) OR (("neovascular glaucoma"[tiab] OR "neovascular glaucomas"[tiab])) OR (NVG[tiab]) OR (((moderate*[tiab] OR severe*[tiab] OR reduced[tiab]) AND vis*[tiab])) OR ("Blindness"[Mesh:noexp]) OR ("registered blind"[tiab:~4]) OR (blindness*[tiab]))
```

原因の推測: 参照先の差が伝播

### 66

期待: ("relationship between"[tiab] OR "relationships between"[tiab])

実際:

```text

```

原因の推測: 未対応のワイルドカードまたは句内語幹を省略・要人手判断

### 71

期待: ("natural history"[tiab] OR "natural histories"[tiab])

実際:

```text

```

原因の推測: 未対応のワイルドカードまたは句内語幹を省略・要人手判断

### 73

期待: (#62 OR … OR #72)

実際:

```text
((occurrence*[tiab]) OR (advancement*[tiab]) OR (worsen*[tiab]) OR ((evolution*[tiab] OR evolv*[tiab])) OR ("Association"[Mesh:noexp]) OR ("correlation of data"[Mesh:noexp]) OR (("incidence"[Mesh:noexp] OR "prevalence"[Mesh:noexp])) OR ("disease progression"[Mesh]) OR (("natural course"[tiab] OR "natural courses"[tiab])))
```

原因の推測: 参照先の差が伝播

### 74

期待: #29 AND #47 AND #61 AND #73

実際:

```text
(((("Risk Factors"[Mesh:noexp]) OR (("risk factor"[tiab] OR "risk factors"[tiab])) OR ("Biomarkers"[Mesh:noexp]) OR (biomarker*[tiab]) OR (marker*[tiab]) OR (("biological marker"[tiab] OR "biological markers"[tiab])) OR ("Vascular Endothelial Growth Factor A"[Mesh:noexp]) OR ("Vascular Endothelial Growth Factor A"[tiab]) OR (VEGF[tiab]) OR ("Intercellular Signaling Peptides and Proteins"[Mesh:noexp]) OR (("growth factor"[tiab] OR "growth factors"[tiab])) OR ("Erythropoietin"[Mesh]) OR (erythropoietin*[tiab]) OR (EPO[tiab]) OR (("retinal angiogenic factor"[tiab] OR "retinal angiogenic factors"[tiab])) OR ("Epidemiology"[Mesh]) OR (epidemiolog*[tiab]) OR (("potential role"[tiab] OR "potential roles"[tiab])) OR (((risk*[tiab] OR rate*[tiab]) AND (progress*[tiab] OR complicat*[tiab]))) OR ("Risk Assessment"[Mesh:noexp]) OR ((risk*[tiab] AND (assess*[tiab] OR stratif*[tiab]))) OR ("Phenotype"[Mesh]) OR (phenotype*[tiab]) OR ("Prognosis"[Mesh:noexp]) OR (prognos*[tiab]) OR (predict*[tiab]) OR (model*[tiab]) OR (variable*[tiab]))) AND ((("Diabetic Retinopathy"[Mesh:noexp]) OR (("proliferative diabetic retinopathy"[tiab] OR "proliferative diabetic retinopathies"[tiab])) OR (PDR[tiab]) OR (("nonproliferative diabetic retinopathy"[tiab] OR "nonproliferative diabetic retinopathies"[tiab] OR "non proliferative diabetic retinopathy"[tiab] OR "non proliferative diabetic retinopathies"[tiab])) OR (NPDR[tiab]) OR ((complication*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((("microvascular complication"[tiab] OR "microvascular complications"[tiab]) AND diabet*[tiab])) OR ((severity*[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR[tiab]))) OR ((advanced[tiab] AND (("diabetic retinopathy"[tiab] OR "diabetic retinopathies"[tiab]) OR DR*[tiab]))) OR (("severe retinopathy"[tiab] OR "severe retinopathies"[tiab])) OR ("Retinal Neovascularization"[Mesh:noexp]) OR ((retina*[tiab] AND (neovascularis*[tiab] OR neovasculariz*[tiab]))) OR (("new vessel"[tiab] OR "new vessels"[tiab])) OR (((neovasculari*[tiab] OR ("new vessel"[tiab] OR "new vessels"[tiab])) AND (disc*[tiab] OR retina*[tiab] OR elsewhere[tiab] OR iris*[tiab]))) OR ((NVD[tiab] OR NVE[tiab] OR NVI[tiab])) OR (((vision*[tiab] OR sight*[tiab]) AND threat*[tiab] AND (diabet*[tiab] OR retinopathy*[tiab]))))) AND ((("Vitreous Hemorrhage"[Mesh:noexp]) OR (("vitreous hemorrhage"[tiab] OR "vitreous hemorrhages"[tiab] OR "vitreous haemorrhage"[tiab] OR "vitreous haemorrhages"[tiab])) OR (("tractional retinal detachment"[tiab] OR "tractional retinal detachments"[tiab])) OR (("rhegmatogenous retinal detachment"[tiab] OR "rhegmatogenous retinal detachments"[tiab])) OR ("Glaucoma, Neovascular"[Mesh:noexp]) OR (("neovascular glaucoma"[tiab] OR "neovascular glaucomas"[tiab])) OR (NVG[tiab]) OR (((moderate*[tiab] OR severe*[tiab] OR reduced[tiab]) AND vis*[tiab])) OR ("Blindness"[Mesh:noexp]) OR ("registered blind"[tiab:~4]) OR (blindness*[tiab]))) AND (((occurrence*[tiab]) OR (advancement*[tiab]) OR (worsen*[tiab]) OR ((evolution*[tiab] OR evolv*[tiab])) OR ("Association"[Mesh:noexp]) OR ("correlation of data"[Mesh:noexp]) OR (("incidence"[Mesh:noexp] OR "prevalence"[Mesh:noexp])) OR ("disease progression"[Mesh]) OR (("natural course"[tiab] OR "natural courses"[tiab])))))
```

原因の推測: 参照先の差が伝播
