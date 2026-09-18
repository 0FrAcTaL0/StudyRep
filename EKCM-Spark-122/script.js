'use strict';

/**
 * Калькулятор "Искра-122".
 *
 * Реализовано:
 *  - включение/выключение (тумблер)
 *  - отображение чисел на табло (16 разрядов + плавающая точка).
 *    Три уровня яркости знаков:
 *      0.15 - калькулятор выключен (дежурная засветка);
 *      0.75 - включён, но разряд ещё не содержит введённого значения (нули-заглушки);
 *      1    - разряд, реально входящий в текущее введённое/вычисленное число.
 *    Число выводится начиная с левого края табло.
 *  - ввод цифр и десятичной точки
 *  - смена знака (/-/)
 *  - сброс (СК)
 *  - арифметика: +, -, *, /
 *  - индикация переполнения (флаг OF)
 *  - регистры A1-A5: каждый - просто число (или null, пока не задано).
 *    Обмена данными с экраном больше нет - кнопка A1..A5 выполняет ровно
 *    одну из двух операций, без свапа (см. pressRegisterButton):
 *      - на экране есть активное введённое значение (hasValue) -> "заслать
 *        с перезаписью": текущее значение всегда записывается в регистр,
 *        замещая собой то, что там было (даже если там уже что-то лежало) -
 *        старое содержимое регистра нигде не сохраняется и на экран не
 *        возвращается;
 *      - на экране дежурный "0" (hasValue === false) -> "вытащить с
 *        перезаписью, заменяя нулями": значение регистра выводится на
 *        экран, а сам регистр очищается (становится пустым/"нулевым",
 *        как будто в него никогда не заносили значение).
 *    Занесение в регистр может дополнительно "удалять источник" (после
 *    сохранения экран возвращается к дежурному "0") или нет - режим
 *    переключается константой MEMORY_STORE_DELETES_SOURCE.
 *    Кнопки "2"/"3" - прибавляют текущее значение с экрана к A2/A3
 *    соответственно (см. addToRegister), их поведение не изменилось.
 *  - регистр буфера клавиатуры (КБ, state.keyboardBuffer): не клон текущего
 *    вводимого значения, а именно ПРЕДЫДУЩИЙ операнд, если он был. Пока в
 *    буфере нет зафиксированного значения (null - "режим зеркала"), он
 *    просто повторяет текущее вводимое число (см.
 *    getKeyboardBufferDisplayValue). Как только терм реально фиксируется
 *    в контексте вычислений (выбор оператора, закрытие скобки, "=" - см.
 *    finalizeContextTerm), это значение "замораживается" в буфере и
 *    дальнейший ввод цифр его больше не трогает. Разморозить буфер
 *    (вернуть в режим зеркала) можно только двумя способами: вызвать его
 *    из памяти кнопкой "Печать" (см. printKeyboardBuffer - после вывода на
 *    экран буфер сбрасывается) либо выполнить полную очистку СК/включение
 *    (см. resetState). Отображается в общем сегменте регистров вместе с
 *    A1-A5.
 *  - если A1 задан (не null) и второй операнд не введён явно (сразу "оператор" + "="),
 *    он берётся из A1 (сам регистр не меняется, см. calculateResult) - это
 *    касается всех бинарных операций, включая обратное деление
 *  - обратное деление (ģ) - полноценная бинарная операция (как +, -, *, /),
 *    меняющая операнды местами: результат = второй операнд / первый
 *    (а не 1/x, как раньше). Если второй операнд не введён явно, он, как и
 *    для остальных операций, берётся из A1. Квадратный корень, выделение
 *    целой части - по-прежнему немедленные унарные операции над текущим
 *    числом.
 *  - возведение в степень: n нажатий кнопки степени подряд = число в степени
 *    n+1 (степень считается от исходного числа, не от промежуточного результата)
 *  - квадратный корень работает по тому же принципу цепочки, что и степень:
 *    n нажатий кнопки корня подряд = корень (n+1)-й степени от исходного
 *    числа, т.е. √ = степень 1/2, √√ = степень 1/3 и т.д. (см. state.rootChain,
 *    sqrtValue) - также считается от исходного числа цепочки, а не от
 *    промежуточного результата.
 *  - приоритет корня и степени над окружающими бинарными операциями: обе
 *    кнопки применяются ТОЛЬКО к текущему терму (тому значению, которое
 *    сейчас вводится для уже выбранного оператора - см.
 *    ensureCurrentValueIsTermValue), не трогая и не вычисляя ещё не
 *    закрытый оператор внешнего контекста (ctx.pendingOperator). Сам терм
 *    фиксируется в контексте позже, как обычно - при выборе следующего
 *    оператора, закрытии скобки или "=" (см. finalizeContextTerm). Поэтому,
 *    например, "2 * 3 √ =" (или "**") сначала возводит/извлекает корень
 *    именно из 3, и только потом (при "=") домножает результат на 2 - а не
 *    наоборот, как было бы при немедленном вычислении всего "2*3" перед
 *    применением корня/степени.
 *  - точность вычислений (кнопки "B"/13/11/9/7/5/3): ограничивает количество
 *    значащих десятичных разрядов результата вычислений (см. applyPrecisionLimit).
 *    "B" (0) - без ограничения
 *  - скобки "(" / ")": приоритет операций реализован через стек контекстов
 *    вычислений (см. state.contextStack). Каждая "(" открывает новый контекст,
 *    каждая ")" закрывает текущий, считает его двухпроходным алгоритмом
 *    (проход 1: * и /, проход 2: + и -) и кладёт результат во внешний
 *    контекст как обычное введённое число. "=" на верхнем уровне закрывает
 *    все ещё не закрытые скобки автоматически, а затем считает корневой
 *    контекст тем же алгоритмом. Корень и степень в этот проход не
 *    попадают вовсе (см. пункт выше) - к моменту, когда терм попадает в
 *    numbers/operators, они уже применены.
 */

document.addEventListener('DOMContentLoaded', () => {
  const calculator = createCalculator();
  calculator.init();
});

function createCalculator() {
  const MAX_DIGITS = 16;        // количество цифровых разрядов на табло
  const OPACITY_OFF = '0.15';   // калькулятор выключен
  const OPACITY_IDLE = '0.5';  // включён, но разряд - незаполненный ноль-заглушка
  const OPACITY_ACTIVE = '1';   // разряд входит в реально введённое/вычисленное число

  // Режим занесения текущего значения в регистр памяти кнопкой A1..A5
  // (см. pressRegisterButton):
  //  true  - "с удалением": значение ПЕРЕНОСИТСЯ в регистр, а экран после
  //          этого возвращается к дежурному "0" (источник очищается);
  //  false - "без удаления" (старое поведение): значение просто копируется
  //          в регистр, а на экране остаётся как было.
  // Свап уже занятого регистра (когда на экране есть активное значение) в
  // обоих режимах всё равно замещает экран старым содержимым регистра -
  // флаг влияет на случай, когда сохраняем в ещё пустой регистр.
  const MEMORY_STORE_DELETES_SOURCE = true;

  // ---------- Состояние ----------
  const state = {
    powered: false,
    currentValue: '0',        // то, что сейчас вводится/отображается (строка)
    // Каждый уровень вложенности скобок - отдельный контекст вычислений:
    // { numbers: [...], operators: [...], pendingOperator }. operators[i]
    // стоит МЕЖДУ numbers[i] и numbers[i+1]. "(" добавляет контекст в стек,
    // ")" снимает верхний, вычисляет его (см. evaluateContext) и кладёт
    // результат обычным числом в контекст на уровень выше. Индекс 0 -
    // всегда самый внешний ("корневой") контекст, он никогда не снимается
    // кнопкой ")" - только через calculateResult()/resetState().
    contextStack: [createContext()],
    // true, пока для уже выбранного оператора не появилось НИКАКОГО нового
    // значения (ни цифрой, ни скобкой, ни унарной операцией, ни регистром) -
    // именно в этом случае действует автоподстановка из A1 (см. getCurrentTermValue)
    operandPending: false,
    waitingForNewEntry: false,// true сразу после выбора операции или после "="
    overflow: false,
    hasValue: false,          // true, если на табло реально введённое/вычисленное число, а не дежурный "0"
    // Каждый регистр - просто число (или null, если в него ещё ни разу не
    // клали значение). Кнопки "2"/"3" прибавляют текущее значение с экрана
    // к A2/A3 соответственно; A1/A4/A5 хранят/меняют одно значение целиком
    // (см. pressRegisterButton).
    memory: { A1: null, A2: null, A3: null, A4: null, A5: null },
    // Регистр клавиатуры: последнее значение, набранное непосредственно с
    // клавиатуры (цифрами/точкой/сменой знака) - см. верхний doc-комментарий.
    // null, пока ничего не набирали. В отличие от memory, сбрасывается в
    // resetState() (не "энергонезависимый").
    keyboardBuffer: null,
    // Цепочка последовательных нажатий кнопки степени (**): null, если цепочка
    // не активна; { base, exponent } - если предыдущим действием было именно
    // нажатие степени (см. resetPowerChain/powerButtonPressed)
    powerChain: null,
    // Цепочка последовательных нажатий кнопки корня (√): null, если цепочка
    // не активна; { base, degree } - если предыдущим действием было именно
    // нажатие корня (см. resetRootChain/sqrtValue). degree - степень корня
    // (2 = квадратный, 3 = кубический и т.д.), эквивалент степени 1/degree
    rootChain: null,
    // Точность вычислений: 0 - без ограничения (режим "B": до 16 целых
    // значащих разрядов и до 15 дробных - по факту дальше просто работает
    // обычная логика табло/переполнения); 13/11/9/7/5/3 - количество
    // значащих десятичных разрядов результата, считая от первой значащей
    // цифры слева (см. applyPrecisionLimit)
    precision: 0,
  };

  // ---------- DOM-ссылки ----------
  const dom = {};

  function cacheDom() {
    dom.powerSwitch = document.getElementById('myonoffswitch');

    const digitEls = Array.from(document.querySelectorAll('.screen .digit'));
    dom.signEl = digitEls[0];          // знак минус
    dom.digitEls = digitEls.slice(1);  // 16 элементов: [0]=разряд16 ... [15]=разряд1

    // 16 точек: [0..14] - разделители между разрядами, [15] - индикатор переполнения
    dom.dotEls = Array.from(document.querySelectorAll('.screen .dot'));

    dom.registers = {};
    ['A1', 'A2', 'A3', 'A4', 'A5', 'KL'].forEach((key) => {
      const root = document.getElementById(`register_${key}`);
      dom.registers[key] = {
        display: root ? root.querySelector('.register-display') : null, // сюда рендерится строка со значением регистра
      };
    });

    dom.flags = {
      operation: document.getElementById('flag_operation'), // тип последней активированной операции (+, -, *, / и т.д.)
      overflow: document.getElementById('flag_overflow'),
      precision: document.getElementById('flag_precision'), // текущая точность вычислений (0/13/11/9/7/5/3)
    };

    dom.memoryFlags = document.querySelector('.memory_flags');
    dom.instructionButton = document.getElementById('instruction-button');

    dom.keyboard = document.querySelector('.keyboard');
    dom.precisionButtons = Array.from(document.querySelectorAll('.precision-button'));
  }

  // ---------- Инициализация ----------
  function init() {
    cacheDom();
    bindEvents();
    renderPoweredOff(); // при загрузке страницы калькулятор считается выключенным

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitRegisterFontSize);
    } else {
      fitRegisterFontSize();
    }
    window.addEventListener('resize', debounce(fitRegisterFontSize, 150));
  }

  function bindEvents() {
    dom.powerSwitch.addEventListener('change', (event) => {
      if (event.target.checked) {
        turnOn();
      } else {
        turnOff();
      }
    });

    // Один обработчик на всю клавиатуру вместо слушателя на каждую кнопку
    dom.keyboard.addEventListener('click', onKeyboardClick);

    if (dom.instructionButton) {
      dom.instructionButton.addEventListener('click', () => {
        window.open('./instr.html', '_blank');
      });
    }
  }

  function onKeyboardClick(event) {
    const button = event.target.closest('button');
    if (!button || !dom.keyboard.contains(button)) return;

    if (button.classList.contains('precision-button')) {
      handlePrecision(button);
      return;
    }

    if (!state.powered) return; // выключенный калькулятор не реагирует на клавиши

    // Кнопки "A1".."A5" и "3"/"2" в панели памяти обрабатываются отдельно,
    // чтобы не путать их с одноимёнными цифрами основной панели
    if (button.classList.contains('memory-button')) {
      handleMemoryKey(button.value);
      return;
    }

    if (button.value !== undefined) {
      handleKey(button.value);
    }
  }

  // ---------- Включение/выключение ----------
  function turnOn() {
    state.powered = true;
    resetState();
    renderDisplay();
    renderRegisters();
    resetFlags();
  }

  function turnOff() {
    state.powered = false;
    renderPoweredOff();
    updateFlag('precision', 0);
  }

  function resetState() {
    state.currentValue = '0';
    state.contextStack = [createContext()];
    state.operandPending = false;
    state.waitingForNewEntry = false;
    state.overflow = false;
    state.hasValue = false;
    state.powerChain = null;
    state.rootChain = null;
    state.keyboardBuffer = null; // буфер клавиатуры - часть "экрана", сбрасывается вместе с ним; полная очистка - один из двух способов его "разморозить" (см. doc-комментарий вверху файла)
    // Точность вычислений (кнопки "B"/13/11/9/7/5/3) НЕ сбрасываем при СК или
    // включении - это как физический переключатель, который остаётся в своём
    // положении, пока его не переставят вручную
    // память (state.memory) сознательно не сбрасываем при СК/включении -
    // это отдельные, «энергонезависимые» регистры
  }

  // ---------- Обработка обычных клавиш ----------
  function handleKey(value) {
    // Цепочки повторных нажатий "степени" и "корня" держатся только пока
    // подряд жмут именно свою кнопку - любое другое действие (включая
    // нажатие ДРУГОЙ из этих двух кнопок) обрывает цепочку
    if (value !== '**') {
      resetPowerChain();
    }
    if (value !== '√') {
      resetRootChain();
    }

    if (/^[0-9]$/.test(value)) {
      inputDigit(value);
      return;
    }

    switch (value) {
      case '.':
        inputDot();
        break;
      case 'СК':
        clearAll();
        break;
      case '/-/':
        toggleSign();
        break;
      case '+':
      case '-':
      case '*':
      case '/':
      case 'invdiv': // обратное деление: бинарная операция, меняющая операнды местами (см. applyOperator)
        setOperator(value);
        break;
      case '=':
        calculateResult();
        break;
      case '√': // квадратный корень
        sqrtValue();
        break;
      case '**': // возведение в степень: n подряд нажатий -> степень n+1
        powerButtonPressed();
        break;
      case 'ВЦ': // выделение целой части (отбрасываем дробную часть, без округления)
        integerPart();
        break;
      case '()': // «Печать»: вывести на экран значение регистра клавиатуры (буфера)
        printKeyboardBuffer();
        break;
      case '(':
        updateFlag('operation', value);
        openParenthesis();
        break;
      case ')':
        updateFlag('operation', value);
        closeParenthesis();
        break;
      default:
        console.log(`Неизвестная клавиша: ${value}`);
    }
  }

  function handleMemoryKey(value) {
    if (state.overflow) return; // в состоянии переполнения с памятью не работаем
    resetPowerChain(); // работа с регистрами тоже обрывает цепочки повторных нажатий степени/корня
    resetRootChain();

    // "2"/"3" - прибавляют текущее значение с экрана к A2/A3 соответственно
    // (если регистр ещё не использовался - считаем его нулём)
    if (value === '2') {
      addToRegister('A2');
      renderRegisters();
      return;
    }
    if (value === '3') {
      addToRegister('A3');
      renderRegisters();
      return;
    }

    if (/^A[1-5]$/.test(value)) {
      pressRegisterButton(value);
      return;
    }

    console.log(`Неизвестная клавиша памяти: ${value}`);
  }

  // Единая логика для кнопок A1-A5 - БЕЗ обмена данными, только две
  // независимые операции "с перезаписью":
  //  - на экране есть активное введённое значение (hasValue) -> "заслать":
  //    текущее значение ВСЕГДА (даже если в регистре уже что-то лежало)
  //    записывается в регистр, замещая его прежнее содержимое. Старое
  //    содержимое регистра нигде не сохраняется и на экран не возвращается;
  //  - на экране дежурный "0" (hasValue === false) -> "вытащить": значение
  //    регистра выводится на экран, а сам регистр заменяется нулём/пустотой
  //    (как будто в него никогда не клали значение). Если регистр и так пуст -
  //    вытаскивать нечего, ничего не происходит.
  function pressRegisterButton(name) {
    if (state.hasValue) {
      state.memory[name] = parseFloat(state.currentValue);
      // Если включён режим переноса с удалением, источник (экран) очищается
      if (MEMORY_STORE_DELETES_SOURCE) clearCurrentValueToIdle();
    } else {
      const stored = state.memory[name];
      if (stored === null) return; // регистр пуст - вытаскивать нечего
      recallValue(stored);
      state.memory[name] = null; // "заменяя нулями" - регистр снова пуст
    }
    renderRegisters();
  }

  // Возвращает экран к дежурному состоянию ("0", без активного введённого
  // значения) - используется при занесении в регистр памяти "с удалением
  // источника" (см. MEMORY_STORE_DELETES_SOURCE)
  function clearCurrentValueToIdle() {
    state.currentValue = '0';
    state.hasValue = false;
    state.waitingForNewEntry = false;
    state.operandPending = false;
    renderDisplay();
  }

  function addToRegister(name) {
    const current = state.memory[name] === null ? 0 : state.memory[name];
    state.memory[name] = current + parseFloat(state.currentValue);
  }

  // Выводит извлечённое из регистра значение на экран как новое текущее число
  function recallValue(value) {
    state.currentValue = formatNumberForEntry(value);
    state.waitingForNewEntry = true; // следующая цифра начнёт новый ввод, а не допишется к этому числу
    state.hasValue = true;
    state.operandPending = false;
    renderDisplay();
  }

  function handlePrecision(button) {
    const precision = button.dataset.precision;
    const wasActive = button.classList.contains('active');

    // Снимаем "прожатость" со всех кнопок точности — активна максимум одна
    dom.precisionButtons.forEach((btn) => btn.classList.remove('active'));

    if (wasActive) {
      // Повторный клик по уже активной кнопке — сбрасываем точность к "B" (0)
      state.precision = 0;
    } else {
      button.classList.add('active');
      state.precision = parseInt(precision, 10) || 0;
    }

    updateFlag('precision', state.precision);
  }

  // ---------- Ввод числа ----------
  function inputDigit(digit) {
    if (state.overflow) return;
    if (state.waitingForNewEntry) {
      state.currentValue = digit;
      state.waitingForNewEntry = false;
    } else if (state.currentValue === '0' && state.hasValue) {
      // На экране уже лежит явно введённый (не дежурный) "0" - значит,
      // начинается правильная дробь: запятая ставится автоматически, без
      // отдельного нажатия "," - например, "0" затем "5" дают "0,5"
      state.currentValue = '0.' + digit;
    } else if (state.currentValue === '0') {
      state.currentValue = digit;
    } else {
      if (countSignificantDigits(state.currentValue) >= MAX_DIGITS) triggerOverflow(); // разряды кончились, вызываем переполнение
      state.currentValue += digit;
    }
    state.hasValue = true;
    state.operandPending = false;
    refreshKeyboardBufferDisplay();
    renderDisplay();
  }

  function inputDot() {
    if (state.overflow) return;

    if (state.waitingForNewEntry) {
      state.currentValue = '0.';
      state.waitingForNewEntry = false;
    } else if (!state.currentValue.includes('.')) {
      state.currentValue += '.';
    }
    state.hasValue = true;
    state.operandPending = false;
    refreshKeyboardBufferDisplay();
    renderDisplay();
  }

  function toggleSign() {
    if (state.overflow) return;

    if (state.currentValue.startsWith('-')) {
      state.currentValue = state.currentValue.slice(1);
    } else if (state.currentValue !== '0') {
      state.currentValue = '-' + state.currentValue;
    }
    refreshKeyboardBufferDisplay();
    renderDisplay();
  }

  // Перерисовывает регистры после ввода цифры/точки/смены знака. Сам буфер
  // клавиатуры (state.keyboardBuffer) здесь НЕ трогаем: пока он "заморожен"
  // (не null), дальнейший набор цифр на него не влияет - в буфере остаётся
  // зафиксированный предыдущий операнд; пока он null ("режим зеркала"),
  // отображаемое значение и так пересчитывается на лету из currentValue (см.
  // getKeyboardBufferDisplayValue), явно обновлять состояние не нужно -
  // достаточно просто перерисовать регистры
  function refreshKeyboardBufferDisplay() {
    renderRegisters();
  }

  function clearAll() {
    resetState();
    renderDisplay();
    renderRegisters();
    resetFlags();
    dom.digitEls[0].style.opacity = OPACITY_ACTIVE;
  }

  // ---------- Скобки и контексты вычислений ----------
  // Контекст - это "уровень вложенности" выражения. numbers/operators
  // копят термы по мере ввода (без немедленного вычисления), а посчитываются
  // они только при закрытии скобки или на "=" - см. evaluateContext.
  function createContext() {
    return {
      numbers: [],
      operators: [],
      pendingOperator: null,
    };
  }

  function currentContext() {
    return state.contextStack[state.contextStack.length - 1];
  }

  // Значение, которое нужно использовать как очередной терм: обычно это то,
  // что сейчас на экране, но если оператор уже выбран, а никакого нового
  // значения так и не появилось (operandPending) - подставляем A1, не трогая
  // сам регистр (см. постановку задачи: "второй операнд подставляется из A1,
  // без очистки регистра")
  function getCurrentTermValue() {
    if (state.operandPending && state.memory.A1 !== null) {
      return state.memory.A1;
    }
    return parseFloat(state.currentValue);
  }

  // Заносит в контекст последний терм (то, что сейчас на экране/в A1) вместе
  // с оператором, который его ожидал, если такой был выбран
  function finalizeContextTerm(ctx) {
    const value = getCurrentTermValue();
    ctx.numbers.push(value);
    if (ctx.pendingOperator !== null) {
      ctx.operators.push(ctx.pendingOperator);
      ctx.pendingOperator = null;
    }
    // Терм реально зафиксирован в контексте - он становится "предыдущим
    // операндом" и замораживается в регистре клавиатуры (см. doc-комментарий
    // вверху файла и getKeyboardBufferDisplayValue); дальнейший набор цифр
    // (для следующего терма) на это значение уже не влияет
    state.keyboardBuffer = value;
    renderRegisters();
  }

  // Готовит currentValue к применению унарной операции высшего приоритета
  // (√ или **): убеждается, что на экране лежит именно ТЕКУЩИЙ терм - то,
  // что вводится для уже выбранного оператора (с той же автоподстановкой
  // A1, что и при обычном завершении терма - см. getCurrentTermValue).
  //
  // Если новый операнд уже набран цифрами (operandPending === false) -
  // ничего не делаем: currentValue и так уже верный терм, а висящий
  // оператор внешнего контекста (ctx.pendingOperator) не трогаем и НЕ
  // вычисляем - именно в этом отличие от старой resolvePendingOperand,
  // которая всегда сворачивала весь контекст целиком. Так корень/степень
  // применяются только к своему операнду и получают тем самым высший
  // приоритет: например, "2 * 3 √" сначала берёт корень из 3, а уже потом,
  // при "=", результат домножается на 2 - а не наоборот.
  //
  // Если новый операнд ещё не набирали (operandPending === true, например
  // сразу после выбора оператора нажали √/**) - подставляем то же
  // значение, что подставилось бы при обычном завершении терма (как
  // правило, A1), чтобы унарная операция сработала над реальным операндом,
  // а не над устаревшим числом с экрана. Сам контекст (numbers/operators/
  // pendingOperator) при этом не меняется - терм по-прежнему зафиксируется
  // позже как обычно.
  function ensureCurrentValueIsTermValue() {
    if (!state.operandPending) return;
    const value = getCurrentTermValue();
    state.currentValue = formatNumberForEntry(value);
    state.hasValue = true;
    state.operandPending = false;
  }

  // Двухпроходное вычисление контекста: сначала все "*"/"/", затем "+"/"-"
  // слева направо. Использует applyOperator, поэтому точность/переполнение
  // считаются так же, как и в обычной цепочке вычислений, на каждом шаге -
  // как если бы у прибора был один физический регистр результата.
  function evaluateContext(ctx) {
    const numbers = ctx.numbers.slice();
    const operators = ctx.operators.slice();

    // Проход 1: умножение, деление и обратное деление (тот же приоритет)
    for (let i = 0; i < operators.length; ) {
      if (operators[i] === '*' || operators[i] === '/' || operators[i] === 'invdiv') {
        const result = applyOperator(numbers[i], numbers[i + 1], operators[i]);
        if (state.overflow) return null;
        numbers.splice(i, 2, result);
        operators.splice(i, 1);
      } else {
        i += 1;
      }
    }

    // Проход 2: сложение и вычитание того, что осталось, слева направо
    let acc = numbers[0];
    for (let i = 0; i < operators.length; i++) {
      acc = applyOperator(acc, numbers[i + 1], operators[i]);
      if (state.overflow) return null;
    }

    return acc;
  }

  // "(" - открывает новый (вложенный) контекст: текущий отображаемый терм
  // приостанавливается вместе со своим контекстом на стеке, а ввод начинается
  // "с чистого листа" внутри нового контекста
  function openParenthesis() {
    if (state.overflow) return;
    state.contextStack.push(createContext());
    state.currentValue = '0';
    state.hasValue = false;
    state.waitingForNewEntry = false;
    state.operandPending = true;
    renderDisplay();
  }

  // ")" - завершает текущий (самый вложенный) контекст, считает его двумя
  // проходами и кладёт результат во внешний контекст обычным введённым числом
  function closeParenthesis() {
    if (state.overflow) return;
    if (state.contextStack.length <= 1) return; // нечего закрывать - скобку не открывали

    const ctx = state.contextStack.pop();
    finalizeContextTerm(ctx);
    const result = evaluateContext(ctx);

    if (state.overflow) {
      renderDisplay();
      return;
    }

    state.currentValue = formatNumberForEntry(result);
    state.hasValue = true;
    state.waitingForNewEntry = true;
    state.operandPending = false;
    renderDisplay();
  }

  // ---------- Арифметика ----------
  function setOperator(operator) {
    if (state.overflow) return;
    const ctx = currentContext();

    if (ctx.pendingOperator !== null && state.operandPending) {
      // Оператор уже выбран, а новое значение так и не появилось -
      // пользователь просто передумал насчёт операции, ничего не заносим
      ctx.pendingOperator = operator;
    }
    else {
      // Терм реально завершён - используем ту же логику, что и при закрытии
      // скобки/"=" (заодно замораживает регистр клавиатуры, см.
      // finalizeContextTerm)
      finalizeContextTerm(ctx);
      ctx.pendingOperator = operator;
    }

    state.waitingForNewEntry = true;
    state.operandPending = true; // ждём следующий терм для этого оператора
    state.hasValue = true;
    renderDisplay();
    updateFlag('operation', operator);
  }

  function calculateResult() {
    if (state.overflow) return;

    // Если остались незакрытые скобки - "=" закрывает их все по очереди,
    // как если бы недостающие ")" были нажаты прямо сейчас
    while (state.contextStack.length > 1) {
      closeParenthesis();
      if (state.overflow) return;
    }

    const ctx = state.contextStack[0];
    if (ctx.pendingOperator === null && ctx.numbers.length === 0) return; // считать нечего - оператор ни разу не выбирали

    finalizeContextTerm(ctx);
    const result = evaluateContext(ctx);

    // Начинаем следующее выражение "с чистого листа"
    state.contextStack[0] = createContext();

    if (state.overflow) {
      renderDisplay();
      return;
    }

    state.currentValue = formatNumberForEntry(result);
    state.hasValue = true;
    state.waitingForNewEntry = true;
    state.operandPending = false;

    renderDisplay();
    updateFlag('operation', '=');
  }

  // Ограничивает результат вычисления заданной точностью (см. state.precision).
  //  - precision === 0 ("B"): ничего не делаем, дальше действует обычная
  //    логика табло (до 16 разрядов суммарно, переполнение и т.д.)
  //  - иначе: precision - количество значащих десятичных разрядов, считая
  //    от первой значащей цифры слева. В обоих случаях округляем по границе
  //    precision-го разряда (а не просто отбрасываем хвост):
  //      - если этих разрядов не хватает даже на целую часть числа (она сама
  //        по себе длиннее precision) - округляем в границе precision-го
  //        разряда целой части, младшие разряды при этом зануляются;
  //      - иначе оставшийся "бюджет" значащих цифр уходит на дробную часть,
  //        а округление происходит уже в её последнем разряде - например,
  //        0.000012345657938 при precision=5 -> 0.000012346.
  //        Важно: целая часть на экране в любом случае занимает минимум 1
  //        символ (хотя бы "0" перед запятой), поэтому под дробную часть
  //        физически остаётся не больше MAX_DIGITS минус этот символ - иначе
  //        для маленьких чисел (много ведущих нулей после запятой) запрошенных
  //        precision значащих цифр может не хватить места на табло даже там,
  //        где без ограничения точности результат бы поместился.
  function applyPrecisionLimit(value) {
    if (state.precision === 0 || value === 0) return value;

    const precision = state.precision;
    const negative = value < 0;
    const abs = Math.abs(value);

    const magnitude = Math.floor(Math.log10(abs));
    const integerDigits = magnitude + 1; // может быть <= 0 для чисел меньше 1

    let limited;
    if (integerDigits >= precision) {
      const factor = Math.pow(10, integerDigits - precision);
      limited = Math.round(abs / factor) * factor;
    } else {
      const displayedIntDigits = Math.max(integerDigits, 1); // "0" перед запятой тоже занимает разряд
      const maxFracDigits = MAX_DIGITS - displayedIntDigits;
      const fracDigits = Math.min(precision - integerDigits, maxFracDigits);
      const factor = Math.pow(10, fracDigits);
      limited = Math.round(abs * factor) / factor;
    }

    return negative ? -limited : limited;
  }

  function applyOperator(a, b, operator) {
    let result;
    switch (operator) {
      case '+': result = a + b; break;
      case '-': result = a - b; break;
      case '*': result = a * b; break;
      case '/':
        if (b === 0) {
          triggerOverflow();
          return 0;
        }
        result = a / b;
        break;
      case 'invdiv': // обратное деление: операнды меняются местами - результат = b / a
        if (a === 0) {
          triggerOverflow();
          return 0;
        }
        result = b / a;
        break;
      default:
        result = b;
    }

    result = applyPrecisionLimit(result);

    if (!Number.isFinite(result) || Math.abs(result) >= Math.pow(10, MAX_DIGITS)) {
      triggerOverflow();
      return 0;
    }
    return result;
  }

  function triggerOverflow() {
    state.overflow = true;
    updateFlag('overflow', 1);
  }

  // ---------- Унарные операции (обратное деление, корень, степень, целая часть) ----------
  // Общий помощник: применяет результат унарной операции к текущему значению
  // с той же проверкой переполнения, что и в applyOperator
  function applyUnaryResult(result) {
    result = applyPrecisionLimit(result);
    if (!Number.isFinite(result) || Math.abs(result) >= Math.pow(10, MAX_DIGITS)) {
      triggerOverflow();
      return;
    }
    state.currentValue = formatNumberForEntry(result);
    state.hasValue = true;
    state.waitingForNewEntry = true; // следующая цифра начнёт новый ввод, а не допишется к результату
    state.operandPending = false;
    renderDisplay();
  }

  // «Печать»: выводит на экран текущее значение регистра клавиатуры (либо
  // зафиксированный предыдущий операнд, либо, в режиме зеркала, то же
  // значение, что и так уже на экране - см. getKeyboardBufferDisplayValue).
  // Это одновременно и есть "вызов из памяти" - один из двух способов
  // разморозить буфер (см. doc-комментарий вверху файла): после вывода на
  // экран буфер сбрасывается в null и снова начинает зеркалировать ввод.
  function printKeyboardBuffer() {
    if (state.overflow) return;
    const value = getKeyboardBufferDisplayValue();
    if (value === null) return; // буфер пуст, ещё ничего не набирали и не считали
    recallValue(value);
    state.keyboardBuffer = null; // "вызов из памяти" - буфер снова в режиме зеркала
    renderRegisters();
  }

  // Корень: работает по тому же принципу цепочки, что и степень (см.
  // powerButtonPressed) - n нажатий подряд = корень (n+1)-й степени, т.е.
  // эквивалент степени 1/(n+1). Основание запоминается один раз при первом
  // нажатии цепочки и не меняется, пока нажатия идут подряд (см.
  // resetRootChain в handleKey/handleMemoryKey) - степень корня считается
  // от исходного числа, а не от уже извлечённого на экране результата.
  function sqrtValue() {
    if (state.overflow) return;
    ensureCurrentValueIsTermValue();

    if (state.rootChain === null) {
      state.rootChain = { base: parseFloat(state.currentValue), degree: 2 };
    } else {
      state.rootChain.degree += 1;
    }

    const { base, degree } = state.rootChain;
    if (base < 0) {
      // корень из отрицательного числа не поддерживаем (комплексных чисел нет)
      triggerOverflow();
      renderDisplay();
      return;
    }
    applyUnaryResult(Math.pow(base, 1 / degree));
  }

  function resetRootChain() {
    state.rootChain = null;
  }

  // Выделение целой части: просто отбрасываем дробную часть, без округления
  // (Math.trunc, а не Math.floor - для отрицательных чисел это важно)
  function integerPart() {
    if (state.overflow) return;
    const value = parseFloat(state.currentValue);
    const result = applyPrecisionLimit(Math.trunc(value));

    if (!Number.isFinite(result) || Math.abs(result) >= Math.pow(10, MAX_DIGITS)) {
      triggerOverflow();
      return;
    }

    state.currentValue = formatNumberForEntry(result);
    state.hasValue = true;
    // В отличие от остальных унарных операций (applyUnaryResult), тут
    // waitingForNewEntry = false: после ВЦ число можно сразу дописывать/
    // продолжать редактировать, а не начинать ввод с нуля
    state.waitingForNewEntry = false;
    state.operandPending = false;
    renderDisplay();
  }

  // Возведение в степень: n нажатий подряд -> текущее число в степени (n + 1).
  // Основание запоминается один раз при первом нажатии цепочки и не меняется,
  // пока нажатия идут подряд (см. resetPowerChain в handleKey/handleMemoryKey) -
  // то есть степень считается от исходного числа, а не от уже возведённого
  // на экране результата.
  function powerButtonPressed() {
    if (state.overflow) return;
    ensureCurrentValueIsTermValue();

    if (state.powerChain === null) {
      state.powerChain = { base: parseFloat(state.currentValue), exponent: 2 };
    } else {
      state.powerChain.exponent += 1;
    }

    applyUnaryResult(Math.pow(state.powerChain.base, state.powerChain.exponent));
  }

  function resetPowerChain() {
    state.powerChain = null;
  }

  function formatNumberForEntry(num) {
    if (Number.isInteger(num)) return String(num);
    return String(parseFloat(num.toPrecision(MAX_DIGITS)));
  }

  function countSignificantDigits(str) {
    return str.replace('-', '').replace('.', '').length;
  }

  // ---------- Отрисовка табло ----------
  function renderDisplay() {
    if (state.overflow) {
      renderOverflow();
      return;
    }

    // ...дальше без изменений (totalLength, dom.signEl, digitsSequence и т.д.)
    const { negative, intPart, fracPart } = splitNumberString(state.currentValue);

    const totalLength = intPart.length + fracPart.length;
    if (totalLength > MAX_DIGITS) {
      // Число не помещается на табло целиком - позже здесь появится логика
      // работы с точностью/значащими цифрами
      triggerOverflow();
      renderOverflow();
      return;
    }

    // Знак минус показывается на полной яркости, только когда число
    // действительно отрицательное (и, значит, hasValue уже true) -
    // иначе яркость не важна, т.к. содержимое ячейки пустое
    dom.signEl.style.opacity = negative ? OPACITY_ACTIVE : OPACITY_IDLE;
    dom.signEl.textContent = '-';

    // Число выводится начиная с левого края табло. Разряды, реально входящие
    // в текущее введённое/вычисленное значение, горят на полную (1);
    // оставшиеся справа "нули-заглушки" - дежурные (0.75), пока значения нет
    const digitsSequence = (intPart + fracPart).padEnd(MAX_DIGITS, '0');
    const activeLength = state.hasValue ? intPart.length + fracPart.length : 0;

    dom.digitEls.forEach((el, i) => {
      el.textContent = digitsSequence[i];
      el.style.opacity = i < activeLength ? OPACITY_ACTIVE : OPACITY_IDLE;
    });

    // Гасим все точки, затем зажигаем нужную (десятичный разделитель) -
    // она стоит сразу после целой части, т.к. число прижато к левому краю
    dom.dotEls.forEach((el) => (el.style.opacity = OPACITY_IDLE));
    if (fracPart.length > 0) {
      const dotIndex = intPart.length - 1;
      if (dom.dotEls[dotIndex]) dom.dotEls[dotIndex].style.opacity = OPACITY_ACTIVE;
    }
  }

  function renderOverflow() {
    dom.signEl.style.opacity = OPACITY_IDLE;
    dom.digitEls.forEach((el) => {
      el.textContent = '0';
      el.style.opacity = OPACITY_IDLE;
    });
    dom.dotEls.forEach((el) => {
      // каждая горящая точка - индикатор переполнения
      el.style.opacity = OPACITY_ACTIVE;
    });
  }

  function renderPoweredOff() {
    // Дежурная засветка: все 17 знаков видны, но тускло (0.15) -
    // содержимое возвращаем к исходному виду разметки ("-" и нули)
    dom.signEl.style.opacity = OPACITY_OFF;
    dom.signEl.textContent = '-';
    dom.digitEls.forEach((el) => {
      el.textContent = '0';
      el.style.opacity = OPACITY_OFF;
    });
    dom.dotEls.forEach((el) => (el.style.opacity = OPACITY_OFF));
    renderRegisters();
    resetFlags();
  }

  // Разбирает числовую строку (в т.ч. результат formatNumberForEntry) на
  // знак / целую часть / дробную часть. Общая логика для главного табло
  // (renderDisplay) и для отрисовки регистров (appendRegisterValueRow) -
  // чтобы дробные числа форматировались везде одинаково.
  function splitNumberString(str) {
    const negative = str.startsWith('-');
    const unsigned = negative ? str.slice(1) : str;
    const [intPartRaw, fracPart = ''] = unsigned.split('.');
    const intPart = intPartRaw === '' ? '0' : intPartRaw;
    return { negative, intPart, fracPart };
  }
  // ---------- Регистры памяти ----------
  // Каждая строка регистра строится из тех же "кирпичиков", что и основной
  // экран: отдельный элемент под знак минус + 16 отдельных элементов-разрядов.
  // Число прижимается к левому краю, а разряды, не занятые значением,
  // показываются как дежурные полупрозрачные нули (OPACITY_IDLE) - ровно тот
  // же принцип, что и в renderDisplay().
  //
  // Регистр пока хранит и показывает только целую часть числа: под дробную
  // часть (и её разделительную точку) в разметке регистра нет отдельных
  // элементов, в отличие от основного табло.

  // Дежурная строка регистра, в который ещё ни разу не клали значение - 16
  // одинаково приглушённых нулей, без знака (показывать нечего)
  function appendIdleRegisterRow(container, opacity) {
    const row = document.createElement('span');
    row.className = 'register-digit';
    for (let i = 0; i < (MAX_DIGITS+2); i++) {
      const digitSpan = document.createElement('span');
      digitSpan.className = 'register-digit-char';
      digitSpan.textContent = '0';
      digitSpan.style.opacity = opacity;
      row.appendChild(digitSpan);
    }
    container.appendChild(row);
  }

  // Строка со значением регистра: знак + 16 разрядов, число прижато к
  // левому краю, лишние справа разряды - дежурные (OPACITY_IDLE)
  // Строка со значением регистра: знак + целая часть + (если есть дробная
  // часть) точка + дробная часть, прижато к левому краю; незанятые справа
  // разряды - дежурные (OPACITY_IDLE). Целая и дробная часть вместе делят
  // те же 16 "физических" разрядов, что раньше безраздельно отдавались
  // целой части.
  function appendRegisterValueRow(container, value, activeOpacity) {
    // formatNumberForEntry ограничивает число значащих цифр так же, как это
    // происходит при выводе результата на главное табло - регистр не должен
    // визуально "разъезжаться" даже для очень длинных чисел
    const { negative, intPart, fracPart } = splitNumberString(formatNumberForEntry(value));

    // Дробная часть обрезается по оставшемуся месту (16 минус то, что уже
    // занято целой частью). Если сама целая часть длиннее 16 разрядов
    // (крайний случай, например переполнение при накоплении в addToRegister),
    // она просто обрежется справа при слайсе ниже - у регистра нет
    // собственного флага переполнения, как у главного табло
    const availableForFrac = Math.max(0, MAX_DIGITS - intPart.length);
    const clippedFrac = fracPart.slice(0, availableForFrac);

    const digitsSequence = (intPart + clippedFrac).padEnd(MAX_DIGITS, '0').slice(0, MAX_DIGITS);
    const activeLength = Math.min(intPart.length + clippedFrac.length, MAX_DIGITS);

    const row = document.createElement('p');
    row.className = 'register-digit';

    const signSpan = document.createElement('span');
    signSpan.className = 'register-sign';
    signSpan.textContent = negative ? '-' : '';
    signSpan.style.opacity = negative ? activeOpacity : OPACITY_IDLE;
    row.appendChild(signSpan);

    for (let i = 0; i < (MAX_DIGITS+2); i++) {
      // Точка - отдельный элемент, вставляется один раз, сразу после
      // последнего разряда целой части, и только если дробная часть реально
      // есть (иначе для целых чисел регистр выглядит как раньше)
      if (i === intPart.length && clippedFrac.length > 0) {
        const dotSpan = document.createElement('span');
        dotSpan.className = 'register-dot';
        dotSpan.textContent = '.';
        dotSpan.style.opacity = activeOpacity;
        row.appendChild(dotSpan);
      }

      const digitSpan = document.createElement('span');
      digitSpan.className = 'register-digit-char';
      digitSpan.textContent = digitsSequence[i];
      digitSpan.style.opacity = i < activeLength ? activeOpacity : OPACITY_IDLE;
      row.appendChild(digitSpan);
    }
    container.appendChild(row);
  }

  // Значение, которое сейчас нужно ПОКАЗАТЬ в регистре КБ (KL):
  //  - буфер "заморожен" (не null) -> показываем именно его - зафиксированный
  //    предыдущий операнд, независимо от того, что сейчас набирается на экране;
  //  - буфер пуст (null, "режим зеркала") -> показываем текущее вводимое
  //    значение (или ничего, если на экране дежурный "0" и ничего ещё не
  //    вводилось) - см. doc-комментарий вверху файла
  function getKeyboardBufferDisplayValue() {
    if (state.keyboardBuffer !== null) return state.keyboardBuffer;
    return state.hasValue ? parseFloat(state.currentValue) : null;
  }

  // A1-A5 - из state.memory, KL (регистр клавиатуры) - из
  // getKeyboardBufferDisplayValue (см. выше)
  function getRegisterValue(key) {
    return key === 'KL' ? getKeyboardBufferDisplayValue() : state.memory[key];
  }

  function renderRegisters() {
    Object.keys(dom.registers).forEach((key) => {
      const refs = dom.registers[key];
      if (!refs || !refs.display) return;

      const value = state.powered ? getRegisterValue(key) : null; // при выключенном питании содержимое не показываем
      refs.display.innerHTML = '';

      if (value === null) {
        appendIdleRegisterRow(refs.display, state.powered ? OPACITY_IDLE : OPACITY_OFF);
      } else {
        appendRegisterValueRow(refs.display, value, OPACITY_ACTIVE);
      }
    });
  }

  // ---------- Флаги состояния ----------
  function updateFlag(name, value) {
    if (dom.flags[name]) dom.flags[name].textContent = String(value);
  }

  function resetFlags() {
    updateFlag('operation', 0);
    updateFlag('overflow', 0);
  }

  // ---------- Подгонка размера шрифта регистров под 18 символов ----------
  // (16 цифр + точка + знак минус) - см. appendRegisterValueRow

  // Скрытый элемент-проба: точная копия строки регистра (.register-digit),
  // но вне видимой области документа - используется только для измерения
  // ширины текста при разных font-size, сам по себе никогда не рендерится
  function getRegisterProbe() {
    if (dom.registerProbe) return dom.registerProbe;

    const probe = document.createElement('p');
    probe.className = 'register-digit';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.width = 'auto';
    dom.memoryFlags.appendChild(probe); // тот же родитель, что и у реальных регистров - те же унаследованные стили
    dom.registerProbe = probe;
    return probe;
  }

  // В цифровых шрифтах разные цифры не всегда одинаковой ширины (в отличие
  // от классического моноширинного) - перебираем 0-9 и находим реально самую
  // широкую, чтобы взять её как "худший случай" для всех 16 разрядов
  function findWidestDigit(probe) {
    let widest = '0';
    let widestWidth = 0;
    for (const digit of '0123456789') {
      probe.textContent = digit;
      const width = probe.scrollWidth;
      if (width > widestWidth) {
        widestWidth = width;
        widest = digit;
      }
    }
    return widest;
  }

  // Подбирает font-size (px), при котором строка из 18 символов
  // ("-" + 16 самых широких цифр + ".") гарантированно умещается в один ряд
  // по фактической ширине .register-display, без переноса и без обрезки.
  // Не поднимает размер выше текущего clamp(20px, 2.2vw, 32px) из CSS -
  // только уменьшает при необходимости.
  function fitRegisterFontSize() {
    const sampleDisplay = dom.registers.A1 && dom.registers.A1.display;
    if (!sampleDisplay || sampleDisplay.clientWidth === 0) return; // ещё не размещён на странице

    const probe = getRegisterProbe();
    const cssFontSize = parseFloat(getComputedStyle(dom.memoryFlags).fontSize); // верхняя граница (потолок из clamp)

    probe.style.fontSize = `${cssFontSize}px`;
    const widestDigit = findWidestDigit(probe);
    probe.textContent = '-' + widestDigit.repeat(MAX_DIGITS) + '.'; // 1 + 16 + 1 = 18 символов

    const availableWidth = sampleDisplay.clientWidth - parseFloat(getComputedStyle(probe).paddingLeft);

    let fontSize = cssFontSize;
    probe.style.fontSize = `${fontSize}px`;
    while (probe.scrollWidth > availableWidth && fontSize > 1) {
      fontSize -= 0.5;
      probe.style.fontSize = `${fontSize}px`;
    }

    document.documentElement.style.setProperty('--register-font-size', `${fontSize}px`);
  }

  // Не пересчитываем на каждый resize-пиксель - достаточно раз в 150мс после
  // того, как пользователь перестал менять размер окна
  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  return { init };
}