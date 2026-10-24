---
title: Harbour Toolkit Guide
tags: [guide, sample]
draft: false
---

# Harbour Toolkit Guide

Harbour Toolkit helps you **plan routes**, check the *weather* and keep a log of every trip.
It works offline, and it syncs when a connection comes back.

## Installation ##

Install the command line tool with `npm install -g harbour-cli` and check the version:

```bash
harbour --version
# prints: harbour 2.4.1
```

If you use a proxy, read [the network guide](https://example.com/docs/network "Network") first.
See also the [FAQ][faq] and the [changelog].

Getting started
===============

The first run creates a folder called `.harbour` in your home directory.  
It holds the settings file and the trip log.\
Nothing else is written outside that folder.

Configuration
-------------

Settings live in a single file. Each key has a sensible default, so most people never open it.

~~~toml
[sync]
interval = 300
~~~

***

## Lists

- Plan a route from the harbour map
- Check the tide table before you leave
  and remember that tides change with the moon
- Keep the log up to date

1. Open the app.
2. Choose **New trip**.
3. Fill in the form:
   - departure time
   - crew members
     * skipper
     * first mate
4. Save the trip.

- [ ] Pack the life jackets
- [x] Charge the radio
- [X] Print the chart

* A list item with a code block:

  ```js
  const trip = harbour.plan('north');
  ```

  And a second paragraph inside the same item, indented to the content.

+ Another kind of bullet
+ With a lazy line
continuing the item above.

10) An ordered list starting at ten
11) Uses a parenthesis

## Quotes

> Sailing is the art of being patient.
> It rewards those who wait for the right wind.
>
> > A nested quote inside the first one,
> > with two lines.
>
> Back at the first level, with a lazy
continuation line.

> A quote with a list inside:
> - first point
> - second point
>
> ```python
> print("code inside a quote")
> ```

## Tables

| Option | Default | Description |
| :----- | :-----: | ----------: |
| `interval` | 300 | Seconds between two syncs |
| `units` | metric | Units used for distance and speed |
| `pipe` | `a|b` | A value with \| an escaped pipe |

Name | Value
--- | ---
Speed | 12 knots
Heading | north-east

## Footnotes

The tide tables come from the national survey[^survey] and are updated weekly[^weekly].

[^survey]: The national hydrographic survey publishes
    new tables every month.

    A second paragraph of the same footnote.
[^weekly]: Updates arrive every Monday.

## Code and HTML

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

</details>

## Math

The distance formula is simple.

$$
d = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}
$$

$$ v = d / t $$

Inline math like $v = d / t$ stays in the paragraph.

## Rules

Paragraph before a rule.

---

___

* * *

Setext needs a paragraph right above it, so the rules above stay rules.

## Images

![Harbour map at sunset](images/map.png "Map")

![](images/decoration.png)

<img src="images/logo.png" alt="">

## Hard breaks

Line one with two spaces  
line two with a backslash\
line three ends the paragraph.

A paragraph whose last line ends with a backslash\

## 中文段落

港口工具箱可以帮你规划航线、查看天气，
并记录每一次出海的日志。

> 引用里的中文段落，
> 同样支持多行。

- 列表项一
- 列表项二：包含`行内代码`和[链接](https://example.com/zh)

| 名称 | 说明 |
| --- | --- |
| 航速 | 每小时十二海里 |

### Heading with closing hashes ###

#### Heading with `code` and *emphasis*

#5 is not a heading because there is no space.

#

12345

Text right after a heading
# Heading without a blank line before
Text right after the heading.

[faq]: https://example.com/faq
[changelog]: https://example.com/changelog "Changes"
[Unused Label]: <https://example.com/unused>

## Escapes and edge cases

\# Not a heading, an escaped hash.

1986\. A great year, not a list item.

A line with a trailing pipe character |

- item

      indented code inside the item

- last item

The end.
