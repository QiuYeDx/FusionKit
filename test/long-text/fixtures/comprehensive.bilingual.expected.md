---
title: Harbour Toolkit Guide
tags: [guide, sample]
draft: false
---

# Harbour Toolkit Guide / HARBOUR TOOLKIT GUIDE

Harbour Toolkit helps you **plan routes**, check the *weather* and keep a log of every trip.
It works offline, and it syncs when a connection comes back.

HARBOUR TOOLKIT HELPS YOU **PLAN ROUTES**, CHECK THE *WEATHER* AND KEEP A LOG OF EVERY TRIP. IT WORKS OFFLINE, AND IT SYNCS WHEN A CONNECTION COMES BACK.

## Installation / INSTALLATION ##

Install the command line tool with `npm install -g harbour-cli` and check the version:

INSTALL THE COMMAND LINE TOOL WITH `npm install -g harbour-cli` AND CHECK THE VERSION:

```bash
harbour --version
# prints: harbour 2.4.1
```

If you use a proxy, read [the network guide](https://example.com/docs/network "Network") first.
See also the [FAQ][faq] and the [changelog].

IF YOU USE A PROXY, READ [THE NETWORK GUIDE](https://example.com/docs/network "Network") FIRST. SEE ALSO THE [FAQ][faq] AND THE [CHANGELOG][changelog].

Getting started / GETTING STARTED
===============

The first run creates a folder called `.harbour` in your home directory.  
It holds the settings file and the trip log.\
Nothing else is written outside that folder.

THE FIRST RUN CREATES A FOLDER CALLED `.harbour` IN YOUR HOME DIRECTORY.  
IT HOLDS THE SETTINGS FILE AND THE TRIP LOG.  
NOTHING ELSE IS WRITTEN OUTSIDE THAT FOLDER.

Configuration / CONFIGURATION
-------------

Settings live in a single file. Each key has a sensible default, so most people never open it.

SETTINGS LIVE IN A SINGLE FILE. EACH KEY HAS A SENSIBLE DEFAULT, SO MOST PEOPLE NEVER OPEN IT.

~~~toml
[sync]
interval = 300
~~~

***

## Lists / LISTS

- Plan a route from the harbour map\
  PLAN A ROUTE FROM THE HARBOUR MAP
- Check the tide table before you leave
  and remember that tides change with the moon\
  CHECK THE TIDE TABLE BEFORE YOU LEAVE AND REMEMBER THAT TIDES CHANGE WITH THE MOON
- Keep the log up to date\
  KEEP THE LOG UP TO DATE

1. Open the app.\
   OPEN THE APP.
2. Choose **New trip**.\
   CHOOSE **NEW TRIP**.
3. Fill in the form:\
   FILL IN THE FORM:
   - departure time\
     DEPARTURE TIME
   - crew members\
     CREW MEMBERS
     * skipper\
       SKIPPER
     * first mate\
       FIRST MATE
4. Save the trip.\
   SAVE THE TRIP.

- [ ] Pack the life jackets\
  PACK THE LIFE JACKETS
- [x] Charge the radio\
  CHARGE THE RADIO
- [X] Print the chart\
  PRINT THE CHART

* A list item with a code block:\
  A LIST ITEM WITH A CODE BLOCK:

  ```js
  const trip = harbour.plan('north');
  ```

  And a second paragraph inside the same item, indented to the content.\
  AND A SECOND PARAGRAPH INSIDE THE SAME ITEM, INDENTED TO THE CONTENT.

+ Another kind of bullet\
  ANOTHER KIND OF BULLET
+ With a lazy line
continuing the item above.\
  WITH A LAZY LINE CONTINUING THE ITEM ABOVE.

10) An ordered list starting at ten\
    AN ORDERED LIST STARTING AT TEN
11) Uses a parenthesis\
    USES A PARENTHESIS

## Quotes / QUOTES

> Sailing is the art of being patient.
> It rewards those who wait for the right wind.
>
> SAILING IS THE ART OF BEING PATIENT. IT REWARDS THOSE WHO WAIT FOR THE RIGHT WIND.
>
> > A nested quote inside the first one,
> > with two lines.
> >
> > A NESTED QUOTE INSIDE THE FIRST ONE, WITH TWO LINES.
>
> Back at the first level, with a lazy
continuation line.
>
> BACK AT THE FIRST LEVEL, WITH A LAZY CONTINUATION LINE.

> A quote with a list inside:
>
> A QUOTE WITH A LIST INSIDE:
> - first point\
>   FIRST POINT
> - second point\
>   SECOND POINT
>
> ```python
> print("code inside a quote")
> ```

## Tables / TABLES

| Option<br>OPTION | Default<br>DEFAULT | Description<br>DESCRIPTION |
| :----- | :-----: | ----------: |
| `interval` | 300 | Seconds between two syncs<br>SECONDS BETWEEN TWO SYNCS |
| `units` | metric<br>METRIC | Units used for distance and speed<br>UNITS USED FOR DISTANCE AND SPEED |
| `pipe` | `a|b` | A value with \| an escaped pipe<br>A VALUE WITH \| AN ESCAPED PIPE |

Name<br>NAME | Value<br>VALUE
--- | ---
Speed<br>SPEED | 12 knots<br>12 KNOTS
Heading<br>HEADING | north-east<br>NORTH-EAST

## Footnotes / FOOTNOTES

The tide tables come from the national survey[^survey] and are updated weekly[^weekly].

THE TIDE TABLES COME FROM THE NATIONAL SURVEY[^survey] AND ARE UPDATED WEEKLY[^weekly].

[^survey]: The national hydrographic survey publishes
    new tables every month.\
    THE NATIONAL HYDROGRAPHIC SURVEY PUBLISHES NEW TABLES EVERY MONTH.

    A second paragraph of the same footnote.\
    A SECOND PARAGRAPH OF THE SAME FOOTNOTE.
[^weekly]: Updates arrive every Monday.\
    UPDATES ARRIVE EVERY MONDAY.

## Code and HTML / CODE AND HTML

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

Most people never need these settings.

MOST PEOPLE NEVER NEED THESE SETTINGS.

</details>

## Math / MATH

The distance formula is simple.

THE DISTANCE FORMULA IS SIMPLE.

$$
d = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}
$$

$$ v = d / t $$

Inline math like $v = d / t$ stays in the paragraph.

INLINE MATH LIKE $v = d / t$ STAYS IN THE PARAGRAPH.

## Rules / RULES

Paragraph before a rule.

PARAGRAPH BEFORE A RULE.

---

___

* * *

Setext needs a paragraph right above it, so the rules above stay rules.

SETEXT NEEDS A PARAGRAPH RIGHT ABOVE IT, SO THE RULES ABOVE STAY RULES.

## Images / IMAGES

![Harbour map at sunset](images/map.png "Map")

![HARBOUR MAP AT SUNSET](images/map.png "Map")

![](images/decoration.png)

<img src="images/logo.png" alt="">

## Hard breaks / HARD BREAKS

Line one with two spaces  
line two with a backslash\
line three ends the paragraph.

LINE ONE WITH TWO SPACES  
LINE TWO WITH A BACKSLASH  
LINE THREE ENDS THE PARAGRAPH.

A paragraph whose last line ends with a backslash\

A PARAGRAPH WHOSE LAST LINE ENDS WITH A BACKSLASH\

## 中文段落 / «中文段落»

港口工具箱可以帮你规划航线、查看天气，
并记录每一次出海的日志。

«港口工具箱可以帮你规划航线»、«查看天气»，«并记录每一次出海的日志»。

> 引用里的中文段落，
> 同样支持多行。
>
> «引用里的中文段落»，«同样支持多行»。

- 列表项一\
  «列表项一»
- 列表项二：包含`行内代码`和[链接](https://example.com/zh)\
  «列表项二»：«包含»`行内代码`«和»[«链接»](https://example.com/zh)

| 名称<br>«名称» | 说明<br>«说明» |
| --- | --- |
| 航速<br>«航速» | 每小时十二海里<br>«每小时十二海里» |

### Heading with closing hashes / HEADING WITH CLOSING HASHES ###

#### Heading with `code` and *emphasis* / HEADING WITH `code` AND *EMPHASIS*

#5 is not a heading because there is no space.

#5 IS NOT A HEADING BECAUSE THERE IS NO SPACE.

#

12345

Text right after a heading

TEXT RIGHT AFTER A HEADING
# Heading without a blank line before / HEADING WITHOUT A BLANK LINE BEFORE
Text right after the heading.

TEXT RIGHT AFTER THE HEADING.

[faq]: https://example.com/faq
[changelog]: https://example.com/changelog "Changes"
[Unused Label]: <https://example.com/unused>

## Escapes and edge cases / ESCAPES AND EDGE CASES

\# Not a heading, an escaped hash.

\# NOT A HEADING, AN ESCAPED HASH.

1986\. A great year, not a list item.

1986\. A GREAT YEAR, NOT A LIST ITEM.

A line with a trailing pipe character |

A LINE WITH A TRAILING PIPE CHARACTER |

- item\
  ITEM

      indented code inside the item

- last item\
  LAST ITEM

The end.

THE END.
