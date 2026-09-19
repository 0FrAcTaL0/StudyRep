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

  //  true  - выборка из пустого регистра трактуется как выборка нуля: на
  //          экран выводится "0", а его ведущий разряд засвечивается на
  //          полную яркость (см. showLeadingZeroActive), в точности как
  //          при нажатии СК (см. clearAll);
  //  false - выборка из пустого регистра ничего не делает, экран не
  //          трогается
  const MEMORY_STORE_DELETES_SOURCE = true;

  const AUTO_SUBSTITUTION_KEYS = ['+', '-', '*', '/', 'invdiv', '**', '√', ')', '=', 'ВЦ'];

  // ---------- Состояние ----------
  const state = {
    powered: false,
    currentValue: '0', 

    contextStack: [createContext()],
  
    operandPending: false,
    waitingForNewEntry: false,
    overflow: false,
    hasValue: false,
   
    registerMode: 'recall',
   
    memory: { A1: null, A2: null, A3: null, A4: null, A5: null },
  
    keyboardBuffer: null,

    powerChain: null,

    rootChain: null,

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
    state.keyboardBuffer = null;
    state.registerMode = 'recall';
  }

  // ---------- Обработка обычных клавиш ----------
  function handleKey(value) {
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

    if (!AUTO_SUBSTITUTION_KEYS.includes(value)) {
      state.operandPending = false;
    }
  }

  function handleMemoryKey(value) {
    if (state.overflow) return; // в состоянии переполнения с памятью не работаем
    resetPowerChain(); // работа с регистрами тоже обрывает цепочки повторных нажатий степени/корня
    resetRootChain();

    state.operandPending = false;

    if (value === '2') {
      addToRegister('A2');
      state.registerMode = 'recall'; // накопление в регистре - триггер режима "выборка" для A1-A5
      renderRegisters();
      return;
    }
    if (value === '3') {
      addToRegister('A3');
      state.registerMode = 'recall';
      renderRegisters();
      return;
    }

    if (/^A[1-5]$/.test(value)) {
      pressRegisterButton(value);
      return;
    }

    console.log(`Неизвестная клавиша памяти: ${value}`);
  }

  function pressRegisterButton(name) {
    if (state.registerMode === 'store') {

      state.memory[name] = parseFloat(state.currentValue);
    } else {
      const stored = state.memory[name];
      if (stored !== null) {
        recallValue(stored);
        state.memory[name] = null; // "заменяя нулями" - регистр снова пуст
        if (stored === 0) showLeadingZeroActive();
      } 
      else if (MEMORY_STORE_DELETES_SOURCE) {
        recallValue(0);
        showLeadingZeroActive();
      }
    }

    state.registerMode = 'recall';
    renderRegisters();
  }

  function showLeadingZeroActive() {
    dom.digitEls[0].style.opacity = OPACITY_ACTIVE;
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
      state.currentValue = '0.' + digit;
    } else if (state.currentValue === '0') {
      state.currentValue = digit;
    } else {
      if (countSignificantDigits(state.currentValue) >= MAX_DIGITS) triggerOverflow(); // разряды кончились, вызываем переполнение
      state.currentValue += digit;
    }
    state.hasValue = true;
    state.operandPending = false;
    state.registerMode = 'store'; // ввод числа - триггер режима "заслать" для A1-A5 (см. doc-комментарий вверху файла)
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
    state.registerMode = 'store'; // ввод точки - тоже часть "ввода числа" (см. doc-комментарий вверху файла)
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
    state.registerMode = 'store'; // отрицание - триггер режима "заслать" для A1-A5 (см. doc-комментарий вверху файла)
    refreshKeyboardBufferDisplay();
    renderDisplay();
  }

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

  // без очистки регистра")
  function getCurrentTermValue() {
    if (state.operandPending && state.memory.A1 !== null) {
      return state.memory.A1;
    }
    return parseFloat(state.currentValue);
  }

  function finalizeContextTerm(ctx) {
    const value = getCurrentTermValue();
    ctx.numbers.push(value);
    if (ctx.pendingOperator !== null) {
      ctx.operators.push(ctx.pendingOperator);
      ctx.pendingOperator = null;
    }
    state.keyboardBuffer = value;
    renderRegisters();
  }

  function ensureCurrentValueIsTermValue() {
    if (!state.operandPending) return;
    const value = getCurrentTermValue();
    state.currentValue = formatNumberForEntry(value);
    state.hasValue = true;
    state.operandPending = false;
  }

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

  function openParenthesis() {
    if (state.overflow) return;
    state.contextStack.push(createContext());
    state.currentValue = '0';
    state.hasValue = false;
    state.waitingForNewEntry = false;
    state.operandPending = false;
    renderDisplay();
  }

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
    finalizeContextTerm(ctx);
    ctx.pendingOperator = operator;

    state.waitingForNewEntry = true;
    state.operandPending = true; // ждём следующий терм для этого оператора
    state.hasValue = true;
    state.registerMode = 'recall'; // +,-,×,÷,обр.дел - триггер режима выборка для A1-A5
    renderDisplay();
    updateFlag('operation', operator);
  }

  function calculateResult() {
    if (state.overflow) return;

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

  function printKeyboardBuffer() {
    if (state.overflow) return;
    state.registerMode = 'recall'; // "Печать" - триггер режима "выборка" для A1-A5 (см. doc-комментарий вверху файла)
    const value = getKeyboardBufferDisplayValue();
    if (value === null) return; // буфер пуст, ещё ничего не набирали и не считали
    recallValue(value);
    state.keyboardBuffer = null; // "вызов из памяти" - буфер снова в режиме зеркала
    renderRegisters();
  }

  function sqrtValue() {
    if (state.overflow) return;
    state.registerMode = 'store'; // корень - триггер режима "заслать" для A1-A5 (см. doc-комментарий вверху файла)
    ensureCurrentValueIsTermValue();

    if (state.rootChain === null) {
      state.rootChain = { base: parseFloat(state.currentValue), degree: 2 };
    } else {
      state.rootChain.degree += 1;
    }

    const { base, degree } = state.rootChain;
    if (base < 0) {
      triggerOverflow();
      renderDisplay();
      return;
    }
    applyUnaryResult(Math.pow(base, 1 / degree));
  }

  function resetRootChain() {
    state.rootChain = null;
  }

  function integerPart() {
    if (state.overflow) return;
    state.registerMode = 'store';

    ensureCurrentValueIsTermValue();
    const value = parseFloat(state.currentValue);
    const result = applyPrecisionLimit(Math.trunc(value));

    if (!Number.isFinite(result) || Math.abs(result) >= Math.pow(10, MAX_DIGITS)) {
      triggerOverflow();
      return;
    }

    state.currentValue = formatNumberForEntry(result);
    state.hasValue = true;
    state.waitingForNewEntry = false;
    state.operandPending = false;
    renderDisplay();
  }

  function powerButtonPressed() {
    if (state.overflow) return;
    state.registerMode = 'store'; // степень - триггер режима "заслать" для A1-A5 (см. doc-комментарий вверху файла)
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

    const { negative, intPart, fracPart } = splitNumberString(state.currentValue);

    const totalLength = intPart.length + fracPart.length;
    if (totalLength > MAX_DIGITS) {
      triggerOverflow();
      renderOverflow();
      return;
    }

    dom.signEl.style.opacity = negative ? OPACITY_ACTIVE : OPACITY_IDLE;
    dom.signEl.textContent = '-';

    const digitsSequence = (intPart + fracPart).padEnd(MAX_DIGITS, '0');
    const activeLength = state.hasValue ? intPart.length + fracPart.length : 0;

    dom.digitEls.forEach((el, i) => {
      el.textContent = digitsSequence[i];
      el.style.opacity = i < activeLength ? OPACITY_ACTIVE : OPACITY_IDLE;
    });

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
      el.style.opacity = OPACITY_ACTIVE;
    });
  }

  function renderPoweredOff() {
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

  function splitNumberString(str) {
    const negative = str.startsWith('-');
    const unsigned = negative ? str.slice(1) : str;
    const [intPartRaw, fracPart = ''] = unsigned.split('.');
    const intPart = intPartRaw === '' ? '0' : intPartRaw;
    return { negative, intPart, fracPart };
  }
  // ---------- Регистры памяти ----------

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

  function appendRegisterValueRow(container, value, activeOpacity) {
    const { negative, intPart, fracPart } = splitNumberString(formatNumberForEntry(value));

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

  function getKeyboardBufferDisplayValue() {
    if (state.keyboardBuffer !== null) return state.keyboardBuffer;
    return state.hasValue ? parseFloat(state.currentValue) : null;
  }

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

  function getRegisterProbe() {
    if (dom.registerProbe) return dom.registerProbe;

    const probe = document.createElement('p');
    probe.className = 'register-digit';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.width = 'auto';
    dom.memoryFlags.appendChild(probe);
    dom.registerProbe = probe;
    return probe;
  }

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

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  return { init };
}