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
 *  - ввод цифр и десятичной точки
 *  - смена знака (/-/)
 *  - сброс (СК)
 *  - арифметика
 *  - индикация переполнения
 *  - регистры A1-A5: каждый - просто число (или null, пока не задано).
 *    Кнопка A1..A5 - сохранить/загрузить/обменять текущее значение с
 *    регистром (см. pressRegisterButton); кнопки "2"/"3" - прибавляют
 *    текущее значение с экрана к A2/A3 соответственно (см. addToRegister).
 *  - если A1 задан (не null) и второй операнд не введён явно (сразу "оператор" + "="),
 *    он берётся из A1 (сам регистр не меняется, см. calculateResult)
 *  - обратное деление (1/x), квадратный корень, выделение целой части (без
 *    округления) - как немедленные унарные операции над текущим числом
 *  - возведение в степень: n нажатий кнопки степени подряд = число в степени
 *    n+1 (степень считается от исходного числа, не от промежуточного результата)
 *  - точность вычислений (кнопки "B"/13/11/9/7/5/3): ограничивает количество
 *    значащих десятичных разрядов результата вычислений (см. applyPrecisionLimit).
 *  - скобки "(" / ")": приоритет операций реализован через стек контекстов
 *    вычислений (см. state.contextStack). Каждая "(" открывает новый контекст,
 *    каждая ")" закрывает текущий, считает его двухпроходным алгоритмом
 *    (проход 1: * и /, проход 2: + и -) и кладёт результат во внешний
 *    контекст как обычное введённое число. "=" на верхнем уровне закрывает
 *    все ещё не закрытые скобки автоматически, а затем считает корневой
 *    контекст тем же алгоритмом.
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
    hasValue: false,          // true, если на табло реально введённое/вычисленное число
    // Каждый регистр - просто число (или null, если в него ещё ни разу не
    // клали значение). Кнопки "2"/"3" прибавляют текущее значение с экрана
    // к A2/A3 соответственно; A1/A4/A5 хранят/меняют одно значение целиком
    // (см. pressRegisterButton).
    memory: { A1: null, A2: null, A3: null, A4: null, A5: null },
    // Цепочка последовательных нажатий кнопки степени (**): null, если цепочка
    // не активна; { base, exponent } - если предыдущим действием было именно
    // нажатие степени (см. resetPowerChain/powerButtonPressed)
    powerChain: null,
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
    ['A1', 'A2', 'A3', 'A4', 'A5'].forEach((key) => {
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

    dom.keyboard = document.querySelector('.keyboard');
  }

  // ---------- Инициализация ----------
  function init() {
    cacheDom();
    bindEvents();
    renderPoweredOff(); // при загрузке страницы калькулятор считается выключенным
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
  }

  function onKeyboardClick(event) {
    const button = event.target.closest('button');
    if (!button || !dom.keyboard.contains(button)) return;
    if (!state.powered) return; // выключенный калькулятор не реагирует на клавиши

    if (button.classList.contains('precision-button')) {
      handlePrecision(button.dataset.precision);
      return;
    }

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
    resetRegisters();
  }

  function resetState() {
    state.currentValue = '0';
    state.contextStack = [createContext()];
    state.operandPending = false;
    state.waitingForNewEntry = false;
    state.overflow = false;
    state.hasValue = false;
    state.powerChain = null;
    // Точность вычислений (кнопки "B"/13/11/9/7/5/3) НЕ сбрасываем при СК или
    // включении - это как физический переключатель, который остаётся в своём
    // положении, пока его не переставят вручную
    // память (state.memory) сознательно не сбрасываем при СК/включении -
    // это отдельные, «энергонезависимые» регистры
  }

  // ---------- Обработка обычных клавиш ----------
  function handleKey(value) {
    // Цепочка повторных нажатий "степени" держится только пока подряд жмут
    // именно эту кнопку - любое другое действие её обрывает
    if (value !== '**') {
      resetPowerChain();
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
        setOperator(value);
        break;
      case '=':
        calculateResult();
        break;
      case 'invdiv': // обратное деление: 1 / текущее число
        invertValue();
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
    resetPowerChain(); // работа с регистрами тоже обрывает цепочку повторных нажатий степени

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

  // Единая логика для кнопок A1-A5:
  //  - регистр ещё не использовался (null) -> сохраняем в него текущее значение;
  //  - регистр уже содержит значение и на экране есть активное значение (hasValue) ->
  //    обмен: текущее значение уходит в регистр, а то, что там лежало,
  //    выходит на экран;
  //  - регистр содержит значение, но на экране дежурный "0" (hasValue === false) ->
  //    просто выводим значение регистра на экран, сам регистр не меняем.
  function pressRegisterButton(name) {
    const stored = state.memory[name];

    if (stored === null) {
      state.memory[name] = parseFloat(state.currentValue);
      renderRegisters();
      return;
    }
    if (state.hasValue) {
      const value = parseFloat(state.currentValue);
      state.memory[name] = value;
      recallValue(value);
    } else {
      recallValue(stored);
      state.memory[name]=null;
    }
    renderRegisters();
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

  function handlePrecision(precision) {
    state.precision = parseInt(precision, 10) || 0;
    updateFlag('precision', state.precision);
    // Само значение на экране этим не пересчитываем - точность влияет
    // только на результаты последующих вычислений (это переключатель режима)
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
    renderDisplay();
  }

  function toggleSign() {
    if (state.overflow) return;

    if (state.currentValue.startsWith('-')) {
      state.currentValue = state.currentValue.slice(1);
    } else if (state.currentValue !== '0') {
      state.currentValue = '-' + state.currentValue;
    }
    renderDisplay();
  }

  function clearAll() {
    resetState();
    renderDisplay();
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
  }

  // Если у текущего (самого вложенного) контекста есть оператор, ожидающий
  // операнд, а новый операнд так и не появился - "доразрешаем" его прямо
  // сейчас: недостающий операнд берётся через getCurrentTermValue (то есть 
  // из A1, если ничего не вводили), контекст сворачивается до одного
  // промежуточного числа на том же уровне вложенности (сама скобка не
  // закрывается), и это число становится текущим отображаемым значением.
  // Нужно для клавиш «÷» (invdiv/1÷x), «√», «pow» - без этого они бы просто
  // проигнорировали висящий оператор и посчитали своё на устаревшем числе.
  function resolvePendingOperand() {
    const ctx = currentContext();
    if (ctx.pendingOperator === null) return;

    finalizeContextTerm(ctx);
    const result = evaluateContext(ctx);
    if (state.overflow) {
      renderDisplay();
      return;
    }

    ctx.numbers = [result];
    ctx.operators = [];
    ctx.pendingOperator = null;

    state.currentValue = formatNumberForEntry(result);
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

    // Проход 1: умножение и деление
    for (let i = 0; i < operators.length; ) {
      if (operators[i] === '*' || operators[i] === '/') {
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
      const value = getCurrentTermValue();
      ctx.numbers.push(value);
      if (ctx.pendingOperator !== null) ctx.operators.push(ctx.pendingOperator);
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

  // Обратное деление: результат = 1 / текущее число
  function invertValue() {
    if (state.overflow) return;
    resolvePendingOperand();
    if (state.overflow) return;
    const value = parseFloat(state.currentValue);
    if (value === 0) {
      triggerOverflow(); // деление на 0
      renderDisplay();
      return;
    }
    applyUnaryResult(1 / value);
  }

  // Квадратный корень
  function sqrtValue() {
    if (state.overflow) return;
    resolvePendingOperand();
    if (state.overflow) return;
    const value = parseFloat(state.currentValue);
    if (value < 0) {
      // корень из отрицательного числа не поддерживаем (комплексных чисел нет)
      triggerOverflow();
      renderDisplay();
      return;
    }
    applyUnaryResult(Math.sqrt(value));
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
    resolvePendingOperand();
    if (state.overflow) return;

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

    const negative = state.currentValue.startsWith('-');
    const unsigned = negative ? state.currentValue.slice(1) : state.currentValue;
    const [intPartRaw, fracPart = ''] = unsigned.split('.');
    const intPart = intPartRaw === '' ? '0' : intPartRaw;

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
    const row = document.createElement('p');
    row.className = 'register-digit';
    for (let i = 0; i < MAX_DIGITS; i++) {
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
  function appendRegisterValueRow(container, value, activeOpacity) {
    const negative = value < 0;
    const intPart = Math.trunc(Math.abs(value)).toString();
    const digitsSequence = intPart.padEnd(MAX_DIGITS, '0').slice(0, MAX_DIGITS);
    const activeLength = Math.min(intPart.length, MAX_DIGITS);

    const row = document.createElement('p');
    row.className = 'register-digit';

    const signSpan = document.createElement('span');
    signSpan.className = 'register-sign';
    signSpan.textContent = negative ? '-' : '';
    signSpan.style.opacity = negative ? activeOpacity : OPACITY_IDLE;
    row.appendChild(signSpan);

    for (let i = 0; i < MAX_DIGITS; i++) {
      const digitSpan = document.createElement('span');
      digitSpan.className = 'register-digit-char';
      digitSpan.textContent = digitsSequence[i];
      digitSpan.style.opacity = i < activeLength ? activeOpacity : OPACITY_IDLE;
      row.appendChild(digitSpan);
    }
    container.appendChild(row);
  }

  function renderRegisters() {
    Object.keys(dom.registers).forEach((key) => {
      const refs = dom.registers[key];
      if (!refs || !refs.display) return;

      const value = state.powered ? state.memory[key] : null; // при выключенном питании содержимое не показываем
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

  function resetRegisters() {
     for (const key in state.memory) {
        state.memory[key] = null;
    }
  }

  return { init };
}