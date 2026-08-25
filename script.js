document.addEventListener("DOMContentLoaded", () => {

    const buttons = document.querySelectorAll(".project-toggle");

    buttons.forEach((button) => {

        button.addEventListener("click", () => {

            const targetId = button.getAttribute("aria-controls");
            const target = document.getElementById(targetId);

            if (!target) {
                return;
            }

            const isExpanded = button.getAttribute("aria-expanded") === "true";

            button.setAttribute("aria-expanded", String(!isExpanded));

            target.hidden = isExpanded;

            button.textContent = isExpanded
                ? "자세히 보기"
                : "접기";
        });

    });

});
