---
title: Harbour Toolkit Guide
tags: [guide, sample]
draft: false
---

# HARBOUR TOOLKIT GUIDE

HARBOUR TOOLKIT HELPS YOU **PLAN ROUTES**, CHECK THE *WEATHER* AND KEEP A LOG OF EVERY TRIP. IT WORKS OFFLINE, AND IT SYNCS WHEN A CONNECTION COMES BACK.

## INSTALLATION ##

INSTALL THE COMMAND LINE TOOL WITH `npm install -g harbour-cli` AND CHECK THE VERSION:

```bash
harbour --version
# prints: harbour 2.4.1
```

IF YOU USE A PROXY, READ [THE NETWORK GUIDE](https://example.com/docs/network "Network") FIRST. SEE ALSO THE [FAQ][faq] AND THE [CHANGELOG][changelog].

GETTING STARTED
===============

THE FIRST RUN CREATES A FOLDER CALLED `.harbour` IN YOUR HOME DIRECTORY.  
IT HOLDS THE SETTINGS FILE AND THE TRIP LOG.  
NOTHING ELSE IS WRITTEN OUTSIDE THAT FOLDER.

CONFIGURATION
-------------

SETTINGS LIVE IN A SINGLE FILE. EACH KEY HAS A SENSIBLE DEFAULT, SO MOST PEOPLE NEVER OPEN IT.

~~~toml
[sync]
interval = 300
~~~

***

## LISTS

- PLAN A ROUTE FROM THE HARBOUR MAP
- CHECK THE TIDE TABLE BEFORE YOU LEAVE AND REMEMBER THAT TIDES CHANGE WITH THE MOON
- KEEP THE LOG UP TO DATE

1. OPEN THE APP.
2. CHOOSE **NEW TRIP**.
3. FILL IN THE FORM:
   - DEPARTURE TIME
   - CREW MEMBERS
     * SKIPPER
     * FIRST MATE
4. SAVE THE TRIP.

- [ ] PACK THE LIFE JACKETS
- [x] CHARGE THE RADIO
- [X] PRINT THE CHART

* A LIST ITEM WITH A CODE BLOCK:

  ```js
  const trip = harbour.plan('north');
  ```

  AND A SECOND PARAGRAPH INSIDE THE SAME ITEM, INDENTED TO THE CONTENT.

+ ANOTHER KIND OF BULLET
+ WITH A LAZY LINE CONTINUING THE ITEM ABOVE.

10) AN ORDERED LIST STARTING AT TEN
11) USES A PARENTHESIS

## QUOTES

> SAILING IS THE ART OF BEING PATIENT. IT REWARDS THOSE WHO WAIT FOR THE RIGHT WIND.
>
> > A NESTED QUOTE INSIDE THE FIRST ONE, WITH TWO LINES.
>
> BACK AT THE FIRST LEVEL, WITH A LAZY CONTINUATION LINE.

> A QUOTE WITH A LIST INSIDE:
> - FIRST POINT
> - SECOND POINT
>
> ```python
> print("code inside a quote")
> ```

## TABLES

| OPTION | DEFAULT | DESCRIPTION |
| :----- | :-----: | ----------: |
| `interval` | 300 | SECONDS BETWEEN TWO SYNCS |
| `units` | METRIC | UNITS USED FOR DISTANCE AND SPEED |
| `pipe` | `a|b` | A VALUE WITH \| AN ESCAPED PIPE |

NAME | VALUE
--- | ---
SPEED | 12 KNOTS
HEADING | NORTH-EAST

## FOOTNOTES

THE TIDE TABLES COME FROM THE NATIONAL SURVEY[^survey] AND ARE UPDATED WEEKLY[^weekly].

[^survey]: THE NATIONAL HYDROGRAPHIC SURVEY PUBLISHES NEW TABLES EVERY MONTH.

    A SECOND PARAGRAPH OF THE SAME FOOTNOTE.
[^weekly]: UPDATES ARRIVE EVERY MONDAY.

## CODE AND HTML

    harbour sync --force
    harbour log --last 10

    harbour status

<div class="note">
  <p>This note is written in HTML and stays as it is.</p>
</div>

<!--
  A comment that spans
  several lines.
-->

<script>
  console.log('harbour');

  window.harbour = true;
</script>

<details>
<summary>Advanced settings</summary>

MOST PEOPLE NEVER NEED THESE SETTINGS.

</details>

## MATH

THE DISTANCE FORMULA IS SIMPLE.

$$
d = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}
$$

$$ v = d / t $$

INLINE MATH LIKE $v = d / t$ STAYS IN THE PARAGRAPH.

## RULES

PARAGRAPH BEFORE A RULE.

---

___

* * *

SETEXT NEEDS A PARAGRAPH RIGHT ABOVE IT, SO THE RULES ABOVE STAY RULES.

## IMAGES

![HARBOUR MAP AT SUNSET](images/map.png "Map")

![](images/decoration.png)

<img src="images/logo.png" alt="">

## HARD BREAKS

LINE ONE WITH TWO SPACES  
LINE TWO WITH A BACKSLASH  
LINE THREE ENDS THE PARAGRAPH.

A PARAGRAPH WHOSE LAST LINE ENDS WITH A BACKSLASH\

## «中文段落»

«港口工具箱可以帮你规划航线»、«查看天气»，«并记录每一次出海的日志»。

> «引用里的中文段落»，«同样支持多行»。

- «列表项一»
- «列表项二»：«包含»`行内代码`«和»[«链接»](https://example.com/zh)

| «名称» | «说明» |
| --- | --- |
| «航速» | «每小时十二海里» |

### HEADING WITH CLOSING HASHES ###

#### HEADING WITH `code` AND *EMPHASIS*

#5 IS NOT A HEADING BECAUSE THERE IS NO SPACE.

#

12345

TEXT RIGHT AFTER A HEADING
# HEADING WITHOUT A BLANK LINE BEFORE
TEXT RIGHT AFTER THE HEADING.

[faq]: https://example.com/faq
[changelog]: https://example.com/changelog "Changes"
[Unused Label]: <https://example.com/unused>

## ESCAPES AND EDGE CASES

\# NOT A HEADING, AN ESCAPED HASH.

1986\. A GREAT YEAR, NOT A LIST ITEM.

A LINE WITH A TRAILING PIPE CHARACTER |

- ITEM

      indented code inside the item

- LAST ITEM

THE END.
